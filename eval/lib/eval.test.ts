import { describe, test, expect } from "bun:test";
import type { TokenUsage } from "@intx/types/runtime";

import { computeCost, medianMetrics, tallyToolCalls } from "./metrics.js";
import { formatReport } from "./report.js";
import { parseJudgeResponse } from "./judge.js";
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
  completedCleanly: true,
  judge: null,
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
    expect(m.cost.flatFee).toBeUndefined();
  });

  test("preserves the flat-fee flag through the collapse", () => {
    const m = medianMetrics([
      metric({ cost: { known: false, usd: null, flatFee: true } }),
      metric({ cost: { known: false, usd: null, flatFee: true } }),
    ]);
    expect(m.cost.flatFee).toBe(true);
  });

  test("medians the judge across runs instead of inheriting one sample", () => {
    const j = (overall: number) => ({ correctness: overall, scope: overall, quality: overall, overall, rationale: "" });
    // turns differ so the turn-representative (turns:6) would otherwise dictate
    // the judge; aggregation should median across all judged runs instead.
    const m = medianMetrics([
      metric({ turns: 3, judge: j(2) }),
      metric({ turns: 9, judge: j(5) }),
      metric({ turns: 6, judge: j(4) }),
    ]);
    expect(m.judge?.overall).toBe(4);
  });

  test("judge is null when no run was judged", () => {
    const m = medianMetrics([metric({ judge: null }), metric({ judge: null })]);
    expect(m.judge).toBeNull();
  });

  test("aggregate judge ignores unjudged runs", () => {
    const j = { correctness: 3, scope: 3, quality: 3, overall: 3, rationale: "" };
    const m = medianMetrics([metric({ judge: j }), metric({ judge: null })]);
    expect(m.judge?.overall).toBe(3);
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

  test("shows judge scores and flat-fee cost when present", () => {
    const judge = { correctness: 4, scope: 5, quality: 4, overall: 4, rationale: "ok" };
    const a = [metric({ task: "t", judge, cost: { known: false, usd: null, flatFee: true } })];
    const b = [metric({ task: "t", judge: { ...judge, overall: 2 } })];
    const report = formatReport(a, b);
    expect(report).toContain("4/5/4/4");
    expect(report).toContain("flat-fee");
    expect(report).toContain("judge ovr");
  });

  test("judge row shows a dash for an unjudged side", () => {
    const a = [metric({ task: "t", judge: { correctness: 3, scope: 3, quality: 3, overall: 3, rationale: "" } })];
    const b = [metric({ task: "t", judge: null })];
    const report = formatReport(a, b);
    const line = report.split("\n").find((l) => l.trimStart().startsWith("judge") && l.includes("3/3/3/3"));
    expect(line).toBeDefined();
    expect(line!.trimEnd().endsWith("-")).toBe(true);
  });
});

describe("parseJudgeResponse", () => {
  test("parses a clean JSON object", () => {
    const r = parseJudgeResponse('{"correctness":4,"scope":5,"quality":3,"overall":4,"rationale":"solid"}');
    expect(r).toEqual({ correctness: 4, scope: 5, quality: 3, overall: 4, rationale: "solid" });
  });

  test("tolerates code fences and surrounding prose", () => {
    const r = parseJudgeResponse('Here is my review:\n```json\n{"correctness":5,"scope":4,"quality":5,"overall":5,"rationale":"clean"}\n```');
    expect(r?.overall).toBe(5);
  });

  test("clamps out-of-range scores to 1-5", () => {
    const r = parseJudgeResponse('{"correctness":9,"scope":0,"quality":3,"overall":4,"rationale":""}');
    expect(r?.correctness).toBe(5);
    expect(r?.scope).toBe(1);
  });

  test("returns null when a score is missing or non-numeric (no fabrication)", () => {
    expect(parseJudgeResponse('{"correctness":4,"scope":5,"quality":3}')).toBeNull();
    expect(parseJudgeResponse('{"correctness":"good","scope":5,"quality":3,"overall":4}')).toBeNull();
    expect(parseJudgeResponse("not json at all")).toBeNull();
  });
});
