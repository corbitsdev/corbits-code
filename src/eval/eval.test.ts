import { describe, test, expect } from "bun:test";
import type { TokenUsage } from "@intx/types/runtime";

import { computeCost, medianMetrics, tallyToolCalls } from "./metrics.js";
import { formatReport } from "./report.js";
import type { RunMetrics } from "./types.js";

const usage = (input: number, output: number): TokenUsage => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
});

const metric = (over: Partial<RunMetrics> = {}): RunMetrics => ({
  task: "t",
  variant: "A",
  turns: 5,
  toolCalls: 8,
  toolCallsByType: { read_file: 4, edit_file: 3, run_shell: 1 },
  tokens: usage(1000, 200),
  totalTokens: 1200,
  cost: { known: true, usd: 0.01 },
  wallClockMs: 4200,
  passed: true,
  ...over,
});

describe("computeCost", () => {
  test("uses an explicit price override", () => {
    const cost = computeCost(usage(1000, 500), "whatever", null, {
      inputPricePerToken: 0.000002,
      outputPricePerToken: 0.00001,
    });
    expect(cost.known).toBe(true);
    expect(cost.usd).toBeCloseTo(1000 * 0.000002 + 500 * 0.00001, 10);
  });

  test("reports pricing unknown when the model is unpriced and no override", () => {
    const cost = computeCost(usage(1000, 500), "mystery-model", null);
    expect(cost.known).toBe(false);
    expect(cost.usd).toBeNull();
  });
});

describe("tallyToolCalls", () => {
  test("counts calls per tool name across turns", () => {
    const byType = tallyToolCalls([
      { toolCalls: [{ name: "read_file" }, { name: "read_file" }] },
      { toolCalls: [{ name: "edit_file" }] },
    ]);
    expect(byType).toEqual({ read_file: 2, edit_file: 1 });
  });
});

describe("medianMetrics", () => {
  test("medians numeric fields and takes majority pass", () => {
    const m = medianMetrics([
      metric({ turns: 3, totalTokens: 100, passed: true }),
      metric({ turns: 9, totalTokens: 300, passed: true }),
      metric({ turns: 6, totalTokens: 200, passed: false }),
    ]);
    expect(m.turns).toBe(6);
    expect(m.totalTokens).toBe(200);
    expect(m.passed).toBe(true);
  });

  test("stays unknown if any run had unknown cost", () => {
    const m = medianMetrics([
      metric({ cost: { known: true, usd: 0.02 } }),
      metric({ cost: { known: false, usd: null } }),
    ]);
    expect(m.cost.known).toBe(false);
  });
});

describe("formatReport", () => {
  test("pairs variants by task and surfaces unknown pricing", () => {
    const a = [metric({ task: "fix-bug", variant: "base", cost: { known: false, usd: null } })];
    const b = [metric({ task: "fix-bug", variant: "v2", turns: 3 })];
    const report = formatReport(a, b, "base", "v2");
    expect(report).toContain("fix-bug");
    expect(report).toContain("unknown");
    expect(report).toContain("base");
    expect(report).toContain("v2");
    expect(report).toContain("TOTAL");
  });

  test("flags a task present in A but missing from B", () => {
    const report = formatReport([metric({ task: "solo" })], []);
    expect(report).toContain("(no pairing)");
  });
});
