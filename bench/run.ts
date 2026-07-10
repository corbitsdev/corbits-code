// CLI entry point: `bun run bench/run.ts [--json]`.
//
// Runs every workload once, prints a metrics table, checks each result against
// its release budget, and exits non-zero if any hard budget (retained bytes,
// heap after GC, minimum event count) is breached. Elapsed-time overruns are
// reported as soft warnings and do not fail the run.

import { forceGc, measure, type Metrics } from "./measure.js";
import { WORKLOADS } from "./workloads.js";
import { BUDGETS, type Budget } from "./budgets.js";

type Row = { readonly name: string; readonly metrics: Metrics };

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${String(bytes)}B`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function checkBudget(
  name: string,
  metrics: Metrics,
  budget: Budget,
): { readonly failures: string[]; readonly warnings: string[] } {
  const failures: string[] = [];
  const warnings: string[] = [];
  if (metrics.eventCount < budget.minEventCount) {
    failures.push(
      `${name}: eventCount ${String(metrics.eventCount)} < min ${String(budget.minEventCount)}`,
    );
  }
  if (metrics.retainedBytes > budget.maxRetainedBytes) {
    failures.push(
      `${name}: retainedBytes ${formatBytes(metrics.retainedBytes)} > max ${formatBytes(budget.maxRetainedBytes)}`,
    );
  }
  if (metrics.heapUsedAfterGcBytes > budget.maxHeapAfterGcBytes) {
    failures.push(
      `${name}: heapAfterGc ${formatBytes(metrics.heapUsedAfterGcBytes)} > max ${formatBytes(budget.maxHeapAfterGcBytes)}`,
    );
  }
  if (metrics.elapsedMs > budget.softMaxElapsedMs) {
    warnings.push(
      `${name}: elapsed ${metrics.elapsedMs.toFixed(0)}ms > soft ${String(budget.softMaxElapsedMs)}ms`,
    );
  }
  return { failures, warnings };
}

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const rows: Row[] = [];
  const allFailures: string[] = [];
  const allWarnings: string[] = [];

  const gcAvailable = forceGc();

  for (const workload of WORKLOADS) {
    const metrics = await measure(() => workload.run());
    rows.push({ name: workload.name, metrics });
    const budget = BUDGETS[workload.name];
    if (budget !== undefined) {
      const { failures, warnings } = checkBudget(workload.name, metrics, budget);
      allFailures.push(...failures);
      allWarnings.push(...warnings);
    }
  }

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        { gcAvailable, rows, failures: allFailures, warnings: allWarnings },
        null,
        2,
      ) + "\n",
    );
  } else {
    if (!gcAvailable) {
      process.stdout.write(
        "note: no forced-GC hook available; heap readings are live samples. Run with Bun or `node --expose-gc`.\n\n",
      );
    }
    const header =
      pad("workload", 24) +
      pad("elapsed", 10) +
      pad("peakRSS", 10) +
      pad("heapAfterGC", 13) +
      pad("events", 9) +
      "retained";
    process.stdout.write(header + "\n");
    process.stdout.write("-".repeat(header.length) + "\n");
    for (const { name, metrics } of rows) {
      process.stdout.write(
        pad(name, 24) +
          pad(`${metrics.elapsedMs.toFixed(0)}ms`, 10) +
          pad(formatBytes(metrics.peakRssBytes), 10) +
          pad(formatBytes(metrics.heapUsedAfterGcBytes), 13) +
          pad(String(metrics.eventCount), 9) +
          formatBytes(metrics.retainedBytes) +
          "\n",
      );
    }
    process.stdout.write("\n");
    for (const warning of allWarnings) process.stdout.write(`WARN  ${warning}\n`);
    for (const failure of allFailures) process.stdout.write(`FAIL  ${failure}\n`);
  }

  if (allFailures.length > 0) process.exit(1);
}

await main();
