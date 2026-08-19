#!/usr/bin/env bun
/**
 * Offline PerfTrace attribution report.
 *
 * Reads a dump JSON written by dumpSpans() (or a bare spans array) and prints
 * exclusive phase shares: inference / tools / permission.wait / subagent / other.
 * No network, no OTEL, no PostHog.
 *
 * Usage:
 *   bun scripts/perf-report.ts <path-to-perftrace-*.json>
 *   bun scripts/perf-report.ts --json <path>
 *   bun scripts/perf-report.ts --fixture   # golden multi-tool demo
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  attributionFromDump,
  attributionFromSpans,
  formatAttributionReport,
  type AttributionReport,
} from "../src/adapters/perf/attribution-report.js";
import { multiToolTurnFixture } from "../src/adapters/perf/fixtures/multi-tool-turn.js";

function printUsage(): void {
  console.error(`Usage:
  bun scripts/perf-report.ts <path-to-perftrace-*.json>
  bun scripts/perf-report.ts --json <path>     # machine-readable AttributionReport
  bun scripts/perf-report.ts --fixture         # demo on multi-tool golden fixture
`);
}

function emit(report: AttributionReport, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(formatAttributionReport(report));
  }
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    printUsage();
    return args.length === 0 ? 1 : 0;
  }

  const asJson = args.includes("--json");
  const useFixture = args.includes("--fixture");
  const pathArg = args.find((a) => !a.startsWith("-"));

  if (useFixture) {
    const report = attributionFromSpans(multiToolTurnFixture());
    emit(report, asJson);
    return 0;
  }

  if (pathArg === undefined) {
    printUsage();
    return 1;
  }

  const filePath = resolve(pathArg);
  let rawText: string;
  try {
    rawText = await readFile(filePath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`perf-report: failed to read ${filePath}: ${msg}`);
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`perf-report: invalid JSON in ${filePath}: ${msg}`);
    return 1;
  }

  try {
    const report = attributionFromDump(parsed);
    emit(report, asJson);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`perf-report: ${msg}`);
    return 1;
  }
}

const code = await main(process.argv);
process.exit(code);
