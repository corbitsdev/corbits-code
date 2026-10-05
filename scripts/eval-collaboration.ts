#!/usr/bin/env bun
/**
 * CL-9879 interactive-collaboration eval baseline runner (deterministic lane).
 *
 * Replays the frozen scenario set (evals/collaboration/scenarios.json):
 * each scenario contributes one good arm (must pass) and one bad arm (must
 * fail) per repeat through the external transcript scorer, then writes a
 * CollaborationReport JSON plus a human summary. No network, no provider
 * credentials, no model calls: replays pin the scorer, not model variance.
 *
 * Re-measuring (canonical):
 *   bun scripts/eval-collaboration.ts --repeats 2 --out evals/collaboration/baseline-<YYYY-MM-DD>.json
 * Conventions: the scenario set is frozen — re-measures reuse scenarios.json
 * as-is so runs stay comparable. Never edit scenarios.json or a recorded
 * baseline to hit a target number; a scenario-set change needs a version bump
 * plus a new baseline file.
 *
 * Live-model trials are NOT run here: they need an authorized inference run
 * (see evals/collaboration/README.md). Passing --live refuses with guidance
 * instead of silently recording scripted results as live data.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDeterministicReport,
  formatSummary,
  parseScenarioSetFile,
  SCENARIO_SET_VERSION,
  type CollaborationScenarioSet,
} from "../evals/collaboration/lib.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const COLLAB_ROOT = join(REPO_ROOT, "evals", "collaboration");

interface CliOptions {
  scenariosPath: string;
  outPath?: string;
  caseId: string;
  repeats: number;
  seed: number;
  live: boolean;
  help: boolean;
}

function printUsage(): void {
  console.log(`Usage: bun scripts/eval-collaboration.ts [options]

  --scenarios <path>  Scenario-set JSON (default: evals/collaboration/scenarios.json)
  --out <path>        Write the JSON report here (default: stdout only)
  --case <id|all>     Run one scenario or all (default: all)
  --repeats <n>       Repeats per scenario (default: 2; replays are stable)
  --seed <n>          Seed recorded in the report (default: 424242)
  --live              Refuse: live-model trials need an authorized inference
                      run (see evals/collaboration/README.md)
  --help              Print this message`);
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    scenariosPath: join(COLLAB_ROOT, "scenarios.json"),
    caseId: "all",
    repeats: 2,
    seed: 424242,
    live: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--scenarios" && next !== undefined) {
      opts.scenariosPath = resolve(REPO_ROOT, next);
      i++;
    } else if (arg === "--out" && next !== undefined) {
      opts.outPath = resolve(REPO_ROOT, next);
      i++;
    } else if (arg === "--case" && next !== undefined) {
      opts.caseId = next;
      i++;
    } else if (arg === "--repeats" && next !== undefined) {
      opts.repeats = Number.parseInt(next, 10);
      i++;
    } else if (arg === "--seed" && next !== undefined) {
      opts.seed = Number.parseInt(next, 10);
      i++;
    } else if (arg === "--live") {
      opts.live = true;
    } else if (arg === "--help") {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(opts.repeats) || opts.repeats < 1) {
    throw new Error(
      `--repeats must be a positive integer, got ${opts.repeats}`,
    );
  }
  if (!Number.isInteger(opts.seed) || opts.seed < 0) {
    throw new Error(`--seed must be a non-negative integer, got ${opts.seed}`);
  }
  return opts;
}

function commitSha(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("git rev-parse HEAD failed");
  return result.stdout.trim();
}

export function filterScenarios(
  set: CollaborationScenarioSet,
  caseId: string,
): CollaborationScenarioSet {
  if (caseId === "all") return set;
  const scenarios = set.scenarios.filter((scenario) => scenario.id === caseId);
  if (scenarios.length === 0)
    throw new Error(`No scenario matches --case ${caseId}`);
  return { ...set, scenarios };
}

/**
 * Frozen-set compatibility: the runner records baselines only for the
 * scenario-set version it understands, so a version bump forces a conscious
 * runner update instead of silently recording incomparable runs.
 */
export function assertSupportedVersion(set: CollaborationScenarioSet): void {
  if (set.version !== SCENARIO_SET_VERSION) {
    throw new Error(
      `Scenario set version ${set.version} is not this runner's v${SCENARIO_SET_VERSION}; refusing to record an incomparable baseline.`,
    );
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return;
  }
  if (opts.live) {
    throw new Error(
      "Live-model collaboration trials need an authorized inference run: " +
        "record provider/model/effort with observed (not scripted) transcripts " +
        "per evals/collaboration/README.md. This runner only replays frozen controls.",
    );
  }
  const set = filterScenarios(
    parseScenarioSetFile(
      JSON.parse(await readFile(opts.scenariosPath, "utf8")),
    ),
    opts.caseId,
  );
  assertSupportedVersion(set);
  const report = buildDeterministicReport(set, {
    commitSha: commitSha(),
    repeats: opts.repeats,
    seed: opts.seed,
  });
  const summary = formatSummary(report);
  console.log(`\n${summary}`);
  if (opts.outPath !== undefined) {
    await mkdir(dirname(opts.outPath), { recursive: true });
    await writeFile(opts.outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Report written to ${opts.outPath}`);
  }
  if (report.totals.controlsFailed > 0) {
    throw new Error(
      `Paired controls mismatched on ${report.totals.controlsFailed}/${report.totals.trialsTotal} trials — the scorer cannot discriminate this set, refusing to record it as a baseline.`,
    );
  }
}

if (import.meta.main) {
  await main();
}
