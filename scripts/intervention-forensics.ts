// Aggregate scan over the intervention logs written by src/subagent/intervention-log.ts
// (~/.corbits/projects/**/interventions.jsonl) — the data that has to exist
// before any stop/nudge threshold is changed again (CL-6938).
//
// Reports, per intervention id: how often it fired, split by model family, with
// the measured value distribution beside the threshold it crossed, and two
// context columns. These are NOT a measured false-positive rate — a stop on a
// run that had already edited files, or one that fired with turn budget still
// left, is equally consistent with a correct stop or a wrong one:
//
//   edited  — stops that fired on a run which had already edited files.
//   early   — stops that fired before half the turn budget was spent.
//
// Also aggregates outcome records (CL-6938): what each completed dispatch
// actually produced (a salvage kind, or clean-complete), by kind. This is the
// log's only outcome signal, letting a stop record be read alongside what the
// dispatch it touched actually produced — it is still not gate-pass or
// retry-success tracking.
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
  earlyBudget: number;
}

function emptyBucket(): Bucket {
  return {
    count: 0,
    byFamily: new Map(),
    byModel: new Map(),
    values: [],
    thresholds: new Set(),
    editedWork: 0,
    earlyBudget: 0,
  };
}

const root = join(homedir(), ".corbits", "projects");
const files: string[] = [];
findAll(root, INTERVENTION_FILE, files);

const buckets = new Map<string, Bucket>();
const outcomes = new Map<string, number>();
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
    if (record.measurement !== undefined) {
      bucket.values.push(record.measurement.value);
      if (record.measurement.threshold !== undefined) {
        bucket.thresholds.add(record.measurement.threshold);
      }
    }
    const state = record.state;
    if (record.class === "stop" && state !== undefined) {
      if ((state.editedPaths ?? 0) > 0) bucket.editedWork++;
      const turns = state.turnsCompleted ?? 0;
      const max = state.maxTurns ?? 0;
      if (max > 0 && turns < max / 2) bucket.earlyBudget++;
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
console.log(
  "\nintervention                       n   value p50/p90/max   threshold  edited  early",
);
for (const [key, bucket] of rows) {
  const sorted = [...bucket.values].sort((a, b) => a - b);
  const dist =
    sorted.length === 0
      ? "-"
      : `${percentile(sorted, 50)}/${percentile(sorted, 90)}/${sorted[sorted.length - 1]!}`;
  const thresholds = bucket.thresholds.size === 0 ? "-" : [...bucket.thresholds].join(",");
  console.log(
    `${key.padEnd(33)} ${String(bucket.count).padStart(3)}   ${dist.padEnd(16)} ${thresholds.padEnd(10)} ${String(bucket.editedWork).padStart(5)}  ${String(bucket.earlyBudget).padStart(5)}`,
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
// per model, so "which model loops most" reads off directly. This is a count,
// not a rate normalized by dispatch volume: the log's outcome records (total
// completed dispatches) are written from the parent side without a model tag,
// so a per-model denominator is not yet tracked — see the PR description.
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
  "\nedited = stops on runs that had already edited files; early = stops before half the turn budget (context, not a false-positive rate).",
);

if (outcomes.size > 0) {
  console.log("\ndispatch outcomes");
  const outcomeRows = [...outcomes.entries()].sort((a, b) => b[1] - a[1]);
  for (const [kind, count] of outcomeRows) {
    console.log(`${kind.padEnd(20)} ${count}`);
  }
}
