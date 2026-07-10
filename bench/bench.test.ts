// Regression entry point for local dev and CI: `bun test ./bench`.
//
// Each workload runs once and its deterministic hard budgets are asserted.
// Elapsed time is intentionally not asserted here (wall time is environment
// dependent); the `bench/run.ts` CLI surfaces elapsed as a soft warning.

import { describe, expect, test } from "bun:test";

import { measure } from "./measure.js";
import { WORKLOADS } from "./workloads.js";
import { BUDGETS } from "./budgets.js";

describe("performance benchmarks", () => {
  for (const workload of WORKLOADS) {
    test(
      `${workload.name} stays within budget`,
      async () => {
        const budget = BUDGETS[workload.name];
        expect(budget).toBeDefined();
        if (budget === undefined) return;

        const metrics = await measure(() => workload.run());

        expect(metrics.eventCount).toBeGreaterThanOrEqual(budget.minEventCount);
        expect(metrics.retainedBytes).toBeLessThanOrEqual(budget.maxRetainedBytes);
        expect(metrics.heapUsedAfterGcBytes).toBeLessThanOrEqual(
          budget.maxHeapAfterGcBytes,
        );
      },
      30_000,
    );
  }
});
