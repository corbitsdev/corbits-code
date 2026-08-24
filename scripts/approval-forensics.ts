// Aggregate scan over the approval logs written by src/permission/approval-log.ts
// (~/.corbits/projects/**/approvals.jsonl) — the data CL-5666 needed to exist
// before approval volume could be measured at all.
//
// Reports: total asks, split by mode (auto vs interactive) and outcome, a
// per-rule breakdown, and settle-duration and display-delay percentiles (the
// display delay is the CL-5664 signal — a queued gate arming its timeout
// before the operator could see it).
//
// Prints only aggregate counts and timings, never a tool subject or command
// text — the log itself never records either, so there is nothing to leak
// here even by accident.
//
// Run: bun run scripts/approval-forensics.ts

import { readdirSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { APPROVAL_LOG_FILE, type ApprovalRecord } from "../src/permission/approval-log.js";

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
  byOutcome: Map<string, number>;
  byMode: Map<string, number>;
  durations: number[];
  displayDelays: number[];
}

function emptyBucket(): Bucket {
  return {
    count: 0,
    byOutcome: new Map(),
    byMode: new Map(),
    durations: [],
    displayDelays: [],
  };
}

const root = join(homedir(), ".corbits", "projects");
const files: string[] = [];
findAll(root, APPROVAL_LOG_FILE, files);

const buckets = new Map<string, Bucket>();
const sessionsByRule = new Map<string, Set<string>>();
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
    let record: ApprovalRecord;
    try {
      record = JSON.parse(line) as ApprovalRecord;
    } catch {
      malformed++;
      continue;
    }
    if (typeof record.tool !== "string" || typeof record.outcome !== "string") {
      malformed++;
      continue;
    }
    records++;
    const key = record.tool;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = emptyBucket();
      buckets.set(key, bucket);
    }
    bucket.count++;
    bucket.byOutcome.set(record.outcome, (bucket.byOutcome.get(record.outcome) ?? 0) + 1);
    bucket.byMode.set(record.mode, (bucket.byMode.get(record.mode) ?? 0) + 1);
    if (typeof record.durationMs === "number") bucket.durations.push(record.durationMs);
    if (typeof record.displayDelayMs === "number") bucket.displayDelays.push(record.displayDelayMs);

    // Duplicate-rate proxy: how often the same rule fires more than once per
    // session file (a session repeatedly asking for something it was already
    // told no/yes to under a different subject).
    if (record.rule !== undefined) {
      const sessions = sessionsByRule.get(record.rule) ?? new Set<string>();
      sessions.add(file);
      sessionsByRule.set(record.rule, sessions);
    }
  }
}

console.log(`approval logs: ${files.length}`);
console.log(`records: ${records}${malformed > 0 ? ` (${malformed} malformed, skipped)` : ""}`);
if (records === 0) {
  console.log("\nNo approvals logged yet. Run some sessions first.");
  process.exit(0);
}

const rows = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count);
console.log(
  "\ntool                        n  auto/interactive  duration p50/p90/max  displayDelay p50/p90/max",
);
for (const [key, bucket] of rows) {
  const durations = [...bucket.durations].sort((a, b) => a - b);
  const delays = [...bucket.displayDelays].sort((a, b) => a - b);
  const durDist =
    durations.length === 0
      ? "-"
      : `${percentile(durations, 50)}/${percentile(durations, 90)}/${durations[durations.length - 1]!}`;
  const delayDist =
    delays.length === 0
      ? "-"
      : `${percentile(delays, 50)}/${percentile(delays, 90)}/${delays[delays.length - 1]!}`;
  const autoCount = bucket.byMode.get("auto") ?? 0;
  const interactiveCount = bucket.byMode.get("interactive") ?? 0;
  console.log(
    `${key.padEnd(26)} ${String(bucket.count).padStart(3)}  ${String(autoCount).padStart(4)}/${String(interactiveCount).padEnd(11)} ${durDist.padEnd(24)} ${delayDist}`,
  );
}

console.log("\nby outcome");
for (const [key, bucket] of rows) {
  const outcomes = [...bucket.byOutcome.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([outcome, count]) => `${outcome}=${count}`)
    .join(" ");
  console.log(`${key.padEnd(26)} ${outcomes}`);
}

console.log("\nrule -> sessions that hit it at least once (duplicate-rate proxy)");
for (const [rule, sessions] of [...sessionsByRule.entries()].sort(
  (a, b) => b[1].size - a[1].size,
)) {
  console.log(`${rule.padEnd(26)} ${sessions.size}`);
}
