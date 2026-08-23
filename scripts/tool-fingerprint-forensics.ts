// Forensic scan over local session traces (~/.corbits/projects/**/context/turns.jsonl)
// used to re-derive the tool-fingerprint period-detection thresholds in
// src/subagent/stop-policy.ts (detectToolFingerprintThrash). For every
// maximal tool-only run (consecutive assistant turns with tool calls and no
// text) in every local session, finds the largest number of exact repeats
// observed for each candidate period 1-6, plus run-length percentiles —
// mirroring the CL-5611 analysis (54 sessions, healthy streaks topping out
// at 13 turns, zero sessions repeating a fingerprint 3+ times consecutively)
// but extended to check every period, not just period 1.
//
// Run: bun run scripts/tool-fingerprint-forensics.ts
//
// Does not print or retain any turn content — only aggregate counts — so it
// is safe to run without pulling trace data into an LLM context window.

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
}

function fingerprintToolCalls(content: readonly Record<string, unknown>[]): string | null {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type !== "tool_call") continue;
    const name = typeof block.name === "string" ? block.name : "";
    let args: unknown = block.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args) as unknown;
      } catch {
        // keep raw string
      }
    }
    parts.push(`${name}:${stableJson(args)}`);
  }
  if (parts.length === 0) return null;
  parts.sort();
  return parts.join("|");
}

function findAll(dir: string, name: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) findAll(path, name, out);
    else if (entry === name) out.push(path);
  }
}

function periodicSuffixLength(seq: readonly string[], period: number): number {
  let i = seq.length - 1;
  let j = i - period;
  let matched = 0;
  while (j >= 0 && seq[i] === seq[j]) {
    matched++;
    i--;
    j--;
  }
  return matched + period;
}

function maxRepeatsForPeriod(seq: readonly string[], period: number): number {
  return Math.floor(periodicSuffixLength(seq, period) / period);
}

const root = join(homedir(), ".corbits", "projects");
const files: string[] = [];
findAll(root, "turns.jsonl", files);

const MAX_PERIOD_SCANNED = 6;
const periodBest: Record<number, number> = {};
let sessionsWithToolOnlyRun = 0;
const runLengths: number[] = [];

for (const file of files) {
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
  } catch {
    continue;
  }

  const fingerprints: (string | null)[] = [];
  for (const line of lines) {
    let turn: { role?: string; content?: unknown } | undefined;
    try {
      turn = JSON.parse(line) as { role?: string; content?: unknown };
    } catch {
      continue;
    }
    if (turn.role !== "assistant" || !Array.isArray(turn.content)) continue;
    const content = turn.content as readonly Record<string, unknown>[];
    const hasToolCalls = content.some((b) => b.type === "tool_call");
    const hasText = content.some(
      (b) => b.type === "text" && typeof b.text === "string" && b.text.length > 0,
    );
    fingerprints.push(hasToolCalls && !hasText ? fingerprintToolCalls(content) : null);
  }

  const runs: string[][] = [];
  let run: string[] = [];
  for (const fp of fingerprints) {
    if (fp === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else {
      run.push(fp);
    }
  }
  if (run.length > 0) runs.push(run);
  if (runs.length > 0) sessionsWithToolOnlyRun++;

  for (const r of runs) {
    runLengths.push(r.length);
    for (let end = 1; end <= r.length; end++) {
      const prefix = r.slice(0, end);
      for (let period = 1; period <= MAX_PERIOD_SCANNED; period++) {
        if (prefix.length < period) continue;
        const reps = maxRepeatsForPeriod(prefix, period);
        if (reps > (periodBest[period] ?? 0)) periodBest[period] = reps;
      }
    }
  }
}

runLengths.sort((a, b) => a - b);
function percentile(p: number): number {
  if (runLengths.length === 0) return 0;
  const idx = Math.min(runLengths.length - 1, Math.floor((p / 100) * runLengths.length));
  return runLengths[idx] as number;
}

console.log(
  JSON.stringify(
    {
      sessionFilesScanned: files.length,
      sessionsWithToolOnlyRun,
      totalToolOnlyRuns: runLengths.length,
      runLengthP50: percentile(50),
      runLengthP90: percentile(90),
      runLengthP99: percentile(99),
      runLengthMax: runLengths[runLengths.length - 1] ?? 0,
      // Largest number of exact repeats observed anywhere, for each period.
      // A value of 1 means "no repeat beyond the base occurrence was ever
      // observed" at that period.
      maxRepeatsByPeriod: periodBest,
    },
    null,
    2,
  ),
);
