// Aggregate scan over the intervention logs written by
// src/subagent/intervention-log.ts (~/.corbits/projects/**/interventions.jsonl)
// — the data that has to exist before any stop/nudge threshold is changed again.
//
// Reports per intervention id: fire count split by model family, the measured
// value distribution beside the threshold it crossed, and a context column
// (edited = stops on runs that had already edited files). This is NOT a
// measured false-positive rate — a stop on a run that had already edited
// files is equally consistent with a correct stop or a wrong one.
//
// Also aggregates outcome records (what each dispatch produced, by kind) —
// the log's only outcome signal. Outcome records carry the child's model/
// family, so they double as the per-model dispatch denominator: interventions
// per model divided by dispatches per model is the only actual rate here.
// Everything else stays a raw count — do not add another rate-looking table
// without a tracked denominator.
//
// Run: bun run scripts/intervention-forensics.ts
//
// Prints only aggregate counts and the `detail` field's first token, never
// turn content, so it is safe to run without pulling trace data into context.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { findAll } from "./find-all.js";
import {
  INTERVENTION_FILE,
  type InterventionRecord,
} from "../src/subagent/intervention-log.js";

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  const value = sorted[index];
  if (value === undefined) return 0;
  return value;
}

interface Bucket {
  count: number;
  byFamily: Map<string, number>;
  // Exact model id — byFamily groups e.g. every grok model under "grok".
  byModel: Map<string, number>;
  values: number[];
  thresholds: Set<number>;
  editedWork: number;
}

function emptyBucket(): Bucket {
  return {
    count: 0,
    byFamily: new Map(),
    byModel: new Map(),
    values: [],
    thresholds: new Set(),
    editedWork: 0,
  };
}

const root = join(homedir(), ".corbits", "projects");
const files: string[] = [];
findAll(root, INTERVENTION_FILE, files);

const buckets = new Map<string, Bucket>();
const outcomes = new Map<string, number>();
// Per-model dispatch and intervention counts (stop+nudge only) so a rate can
// be computed instead of a bare count.
const dispatchesByModel = new Map<string, number>();
const interventionsByModel = new Map<string, number>();
let untaggedOutcomes = 0;
let records = 0;
let malformed = 0;

for (const file of files) {
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    continue;
  }
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let record: InterventionRecord;
    try {
      record = JSON.parse(line) as InterventionRecord;
    } catch {
      malformed++;
      continue;
    }
    if (typeof record.id !== "string") {
      malformed++;
      continue;
    }
    records++;
    if (record.class === "outcome" && record.outcome !== undefined) {
      const kind = record.outcome.kind;
      outcomes.set(kind, (outcomes.get(kind) ?? 0) + 1);
      if (record.model !== undefined) {
        dispatchesByModel.set(
          record.model,
          (dispatchesByModel.get(record.model) ?? 0) + 1,
        );
      } else {
        // Outcome records written before model tagging carry no model.
        untaggedOutcomes++;
      }
      continue;
    }
    const key = `${record.class ?? "?"}/${record.id}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = emptyBucket();
      buckets.set(key, bucket);
    }
    const occurrence = record.count ?? 1;
    bucket.count += occurrence;
    const family = record.family ?? record.model ?? "unknown";
    bucket.byFamily.set(
      family,
      (bucket.byFamily.get(family) ?? 0) + occurrence,
    );
    const model = record.model ?? "unknown";
    bucket.byModel.set(model, (bucket.byModel.get(model) ?? 0) + occurrence);
    if (record.class === "stop" || record.class === "nudge") {
      interventionsByModel.set(
        model,
        (interventionsByModel.get(model) ?? 0) + occurrence,
      );
    }
    if (record.measurement !== undefined) {
      bucket.values.push(record.measurement.value);
      if (record.measurement.threshold !== undefined) {
        bucket.thresholds.add(record.measurement.threshold);
      }
    }
    const state = record.state;
    if (record.class === "stop" && state !== undefined) {
      if ((state.editedPaths ?? 0) > 0) bucket.editedWork++;
    }
  }
}

console.log(`intervention logs: ${files.length}`);
console.log(
  `records: ${records}${malformed > 0 ? ` (${malformed} malformed, skipped)` : ""}`,
);
if (records === 0) {
  console.log("\nNo interventions logged yet. Run some sessions first.");
  process.exit(0);
}

const rows = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count);
console.log(
  "\nintervention                       n   value p50/p90/max   threshold  edited",
);
for (const [key, bucket] of rows) {
  const sorted = [...bucket.values].sort((a, b) => a - b);
  const last = sorted[sorted.length - 1];
  const dist =
    sorted.length === 0 || last === undefined
      ? "-"
      : `${percentile(sorted, 50)}/${percentile(sorted, 90)}/${last}`;
  const thresholds =
    bucket.thresholds.size === 0 ? "-" : [...bucket.thresholds].join(",");
  console.log(
    `${key.padEnd(33)} ${String(bucket.count).padStart(3)}   ${dist.padEnd(16)} ${thresholds.padEnd(10)} ${String(bucket.editedWork).padStart(5)}`,
  );
}

console.log("\nby family");
for (const [key, bucket] of rows) {
  const families = [...bucket.byFamily.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([family, count]) => `${family}=${count}`)
    .join(" ");
  console.log(`${key.padEnd(33)} ${families}`);
}

// Mid-stream repetition aborts get their own per-model breakdown so "which
// model loops most" reads off directly. Still a raw count, not a rate.
const repetitionRows = rows.filter(([key]) => key.includes("/repetition-"));
if (repetitionRows.length > 0) {
  const totalsByModel = new Map<string, number>();
  for (const [, bucket] of repetitionRows) {
    for (const [model, count] of bucket.byModel) {
      totalsByModel.set(model, (totalsByModel.get(model) ?? 0) + count);
    }
  }
  console.log(
    "\nrepetition aborts by model (mid-stream degenerate-repetition, all detectors)",
  );
  const modelRows = [...totalsByModel.entries()].sort((a, b) => b[1] - a[1]);
  for (const [model, count] of modelRows) {
    console.log(`${model.padEnd(33)} ${count}`);
  }
  console.log("\nrepetition aborts by model, per detector");
  for (const [key, bucket] of repetitionRows) {
    const models = [...bucket.byModel.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([model, count]) => `${model}=${count}`)
      .join(" ");
    console.log(`${key.padEnd(33)} ${models}`);
  }
}

console.log(
  "\nedited = stops on runs that had already edited files (context, not a false-positive rate).",
);

// The one real rate in this script: interventions per dispatch, per model.
// dispatches = outcome records for that model; interventions = its stop+nudge
// records. Everything above is a count.
if (dispatchesByModel.size > 0 || interventionsByModel.size > 0) {
  console.log(
    "\ninterventions per dispatch by model (stop+nudge count / dispatch count = rate)",
  );
  const models = new Set([
    ...dispatchesByModel.keys(),
    ...interventionsByModel.keys(),
  ]);
  const modelRows = [...models]
    .map((model) => {
      const dispatches = dispatchesByModel.get(model) ?? 0;
      const interventions = interventionsByModel.get(model) ?? 0;
      const rate =
        dispatches > 0 ? (interventions / dispatches).toFixed(3) : "-";
      return { model, dispatches, interventions, rate };
    })
    .sort((a, b) => b.interventions - a.interventions);
  for (const { model, dispatches, interventions, rate } of modelRows) {
    console.log(
      `${model.padEnd(33)} interventions=${String(interventions).padStart(4)} dispatches=${String(dispatches).padStart(5)} rate=${rate}`,
    );
  }
  if (untaggedOutcomes > 0) {
    console.log(
      `(${untaggedOutcomes} outcome record(s) predate model tagging (CL-6968) and are excluded from every dispatch count above.)`,
    );
  }
}

if (outcomes.size > 0) {
  console.log("\ndispatch outcomes");
  const outcomeRows = [...outcomes.entries()].sort((a, b) => b[1] - a[1]);
  for (const [kind, count] of outcomeRows) {
    console.log(`${kind.padEnd(20)} ${count}`);
  }
}
