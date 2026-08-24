// Aggregate scan over the intervention logs written by src/subagent/intervention-log.ts
// (~/.corbits/projects/**/interventions.jsonl) — the data that has to exist
// before any stop/nudge threshold is changed again (CL-6938).
//
// Reports, per intervention id: how often it fired, split by model family, with
// the measured value distribution beside the threshold it crossed, and one
// context column. This is NOT a measured false-positive rate — a stop on a
// run that had already edited files is equally consistent with a correct
// stop or a wrong one:
//
//   edited  — stops that fired on a run which had already edited files.
//
// Also aggregates outcome records: what each completed dispatch actually
// produced (a salvage kind, or clean-complete), by kind. This is the log's
// only outcome signal, letting a stop record be read alongside what the
// dispatch it touched actually produced — it is still not gate-pass or
// retry-success tracking.
//
// Outcome records are now tagged with the dispatched child's provider/model/
// family (CL-6968), so they double as the per-model dispatch denominator:
// interventions per model, divided by dispatches per model, is the one table
// below that is an actual rate. Everything else in this script stays a raw
// count — do not add another table that looks like a rate without a tracked
// denominator behind it (that mistake shipped once already and had to be
// stripped, see CL-6968).
//
// Run: bun run scripts/intervention-forensics.ts
//
// Prints only aggregate counts and the `detail` field's first token, never turn
// content, so it is safe to run without pulling trace data into a context window.

import { readdirSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { INTERVENTION_FILE, type InterventionRecord } from "../src/subagent/intervention-log.js";

// lstat, and skip symlinks: session dirs carry a `latest` symlink to a real
// session, and following it double-counts every record in that session.
function findAll(dir: string, name: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(path);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) findAll(path, name, out);
    else if (entry === name) out.push(path);
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index]!;
}

interface Bucket {
  count: number;
  byFamily: Map<string, number>;
  // Exact model id (CL-6775) — coarser than byFamily, which groups e.g. every
  // grok model under "grok". Answers "which model loops most", not just
  // "which family".
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
// Dispatch counts per model (the outcome record's denominator, CL-6968) and
// intervention counts per model (stop+nudge only — block/outcome are not
// leaf signals), so a rate can be computed instead of a bare count.
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
        dispatchesByModel.set(record.model, (dispatchesByModel.get(record.model) ?? 0) + 1);
      } else {
        // Written before CL-6968 tagged outcome records with model identity.
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
    bucket.count++;
    const family = record.family ?? record.model ?? "unknown";
    bucket.byFamily.set(family, (bucket.byFamily.get(family) ?? 0) + 1);
    const model = record.model ?? "unknown";
    bucket.byModel.set(model, (bucket.byModel.get(model) ?? 0) + 1);
    if (record.class === "stop" || record.class === "nudge") {
      interventionsByModel.set(model, (interventionsByModel.get(model) ?? 0) + 1);
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
console.log(`records: ${records}${malformed > 0 ? ` (${malformed} malformed, skipped)` : ""}`);
if (records === 0) {
  console.log("\nNo interventions logged yet. Run some sessions first.");
  process.exit(0);
}

const rows = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count);
console.log("\nintervention                       n   value p50/p90/max   threshold  edited");
for (const [key, bucket] of rows) {
  const sorted = [...bucket.values].sort((a, b) => a - b);
  const dist =
    sorted.length === 0
      ? "-"
      : `${percentile(sorted, 50)}/${percentile(sorted, 90)}/${sorted[sorted.length - 1]!}`;
  const thresholds = bucket.thresholds.size === 0 ? "-" : [...bucket.thresholds].join(",");
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

// CL-6775: streamed degenerate-repetition aborts (mid-stream, not a turn-level
// stop) get their own model breakdown — "repetition-<detector>" ids, one row
// per model, so "which model loops most" reads off directly. Still a raw
// count, not a rate — see the "interventions per dispatch by model" table
// below for the rate version, computed from the same per-model dispatch
// denominator (outcome records, CL-6968).
const repetitionRows = rows.filter(([key]) => key.includes("/repetition-"));
if (repetitionRows.length > 0) {
  const totalsByModel = new Map<string, number>();
  for (const [, bucket] of repetitionRows) {
    for (const [model, count] of bucket.byModel) {
      totalsByModel.set(model, (totalsByModel.get(model) ?? 0) + count);
    }
  }
  console.log("\nrepetition aborts by model (mid-stream degenerate-repetition, all detectors)");
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
// dispatches = outcome records tagged with that model (CL-6968); interventions
// = stop+nudge records for that model. Everything above this is a count.
if (dispatchesByModel.size > 0 || interventionsByModel.size > 0) {
  console.log("\ninterventions per dispatch by model (stop+nudge count / dispatch count = rate)");
  const models = new Set([...dispatchesByModel.keys(), ...interventionsByModel.keys()]);
  const modelRows = [...models]
    .map((model) => {
      const dispatches = dispatchesByModel.get(model) ?? 0;
      const interventions = interventionsByModel.get(model) ?? 0;
      const rate = dispatches > 0 ? (interventions / dispatches).toFixed(3) : "-";
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
