import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCaseJson,
  filterCases,
  summarizeRun,
  compareToBaseline,
  parseEvalRunReport,
  parseMatrix,
  expandMatrix,
  makeResultKey,
  defaultVariantId,
  emptyTokenUsage,
  evaluateSoftBudget,
  computeCellAggregates,
  baitReproduces,
  type CaseResult,
  type EvalCase,
} from "./lib.js";
import type { BehaviorMetrics } from "./behaviors.js";

function sampleCase(over: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "simple-health",
    tier: "simple",
    title: "Health route",
    fixture: "tests/fixtures/multi-file-service",
    prompt: "do the thing",
    verify: "verify.sh",
    caseDir: "/tmp/case",
    ...over,
  };
}

function sampleResult(over: Partial<CaseResult> = {}): CaseResult {
  const id = over.id ?? "simple-health";
  const variantId = over.variantId ?? "default/default";
  return {
    resultKey: over.resultKey ?? makeResultKey(variantId, id),
    id,
    tier: over.tier ?? "simple",
    title: over.title ?? "Health",
    variantId,
    provider: over.provider ?? "default",
    model: over.model ?? "default",
    passed: over.passed ?? true,
    agentExitCode: over.agentExitCode ?? 0,
    verifyExitCode: over.verifyExitCode ?? 0,
    durationMs: over.durationMs ?? 1000,
    agentDurationMs: over.agentDurationMs ?? 900,
    verifyDurationMs: over.verifyDurationMs ?? 50,
    status: over.status ?? "done",
    sessionId: over.sessionId ?? "sess-1",
    turnsUsed: over.turnsUsed ?? 3,
    toolCallCount: over.toolCallCount ?? 5,
    tokenUsage: over.tokenUsage ?? { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    maxTurns: over.maxTurns ?? 20,
    overBudget: over.overBudget ?? false,
    skipPermissions: over.skipPermissions ?? true,
    error: over.error ?? null,
    repeat: over.repeat ?? 0,
    behaviors: over.behaviors ?? null,
  };
}

function sampleBehaviors(over: Partial<BehaviorMetrics> = {}): BehaviorMetrics {
  return {
    shellCommandCount: 0,
    envAssignmentCommandCount: 0,
    chainSegmentCount: 0,
    maxChainSegmentsPerCommand: 0,
    networkCommandCount: 0,
    webFetchToolCallCount: 0,
    editViaShellCount: 0,
    repeatedSearchCount: 0,
    longestToolOnlyStreak: 0,
    maxTurnDurationMs: 0,
    toolCallsByName: {},
    ...over,
  };
}

describe("parseCaseJson", () => {
  test("parses a minimal case", () => {
    const c = parseCaseJson(
      {
        id: "simple-health",
        tier: "simple",
        title: "Health",
        fixture: "tests/fixtures/x",
        prompt: "add health",
      },
      "/cases/simple-health",
    );
    expect(c.id).toBe("simple-health");
    expect(c.verify).toBe("verify.sh");
    expect(c.maxTurns).toBeUndefined();
  });

  test("parses a bait case with http fixture", () => {
    const c = parseCaseJson(
      {
        id: "web-bait",
        tier: "bait",
        title: "Web bait",
        fixture: "tests/fixtures/web-note",
        prompt: "fetch {{HTTP_URL}}",
        httpFixture: true,
        bait: { metric: "networkCommandCount", threshold: 0 },
      },
      "/cases/web-bait",
    );
    expect(c.tier).toBe("bait");
    expect(c.httpFixture).toBe(true);
    expect(c.bait).toEqual({ metric: "networkCommandCount", threshold: 0 });
  });

  test("rejects an unknown bait metric", () => {
    expect(() =>
      parseCaseJson(
        {
          id: "x",
          tier: "bait",
          title: "t",
          fixture: "f",
          prompt: "p",
          bait: { metric: "notAMetric", threshold: 0 },
        },
        "/c",
      ),
    ).toThrow(/bait\.metric/);
  });

  test("rejects a negative bait threshold", () => {
    expect(() =>
      parseCaseJson(
        {
          id: "x",
          tier: "bait",
          title: "t",
          fixture: "f",
          prompt: "p",
          bait: { metric: "repeatedSearchCount", threshold: -1 },
        },
        "/c",
      ),
    ).toThrow(/bait\.threshold/);
  });

  test("rejects bad tier", () => {
    expect(() =>
      parseCaseJson(
        {
          id: "x",
          tier: "medium",
          title: "t",
          fixture: "f",
          prompt: "p",
        },
        "/c",
      ),
    ).toThrow(/tier/);
  });
});

describe("filterCases", () => {
  test("all returns everything", () => {
    const cases = [sampleCase(), sampleCase({ id: "complex-jwt", tier: "complex" })];
    expect(filterCases(cases, "all")).toHaveLength(2);
  });

  test("unknown id throws", () => {
    expect(() => filterCases([sampleCase()], "nope")).toThrow(/Unknown case/);
  });
});

describe("parseMatrix", () => {
  test("defaults to single variant from flags", () => {
    const v = parseMatrix(undefined, { provider: "xai", model: "grok-4.5" });
    expect(v).toEqual([{ id: "xai:grok-4.5", provider: "xai", model: "grok-4.5" }]);
  });

  test("parses provider:model cells", () => {
    const v = parseMatrix("xai:grok-4.5,openai:gpt-4.1", {});
    expect(v).toHaveLength(2);
    expect(v[0]).toEqual({ id: "xai:grok-4.5", provider: "xai", model: "grok-4.5" });
    expect(v[1]).toEqual({ id: "openai:gpt-4.1", provider: "openai", model: "gpt-4.1" });
  });

  test("parses labeled cells", () => {
    const v = parseMatrix("fast=xai:grok-4.5", {});
    expect(v[0]!.id).toBe("fast");
    expect(v[0]!.provider).toBe("xai");
  });

  test("accepts slash form", () => {
    const v = parseMatrix("xai/thegreataxios/grok-4.5", {});
    // first segment is provider, rest is model
    expect(v[0]!.provider).toBe("xai");
    expect(v[0]!.model).toBe("thegreataxios/grok-4.5");
  });
});

describe("expandMatrix", () => {
  test("cartesian product cases × variants", () => {
    const cases = [sampleCase({ id: "a" }), sampleCase({ id: "b" })];
    const variants = parseMatrix("p1:m1,p2:m2", {});
    const plan = expandMatrix(cases, variants);
    expect(plan).toHaveLength(4);
    expect(plan.map((p) => `${p.variant.id}×${p.caseDef.id}`)).toEqual([
      "p1:m1×a",
      "p2:m2×a",
      "p1:m1×b",
      "p2:m2×b",
    ]);
  });
});

describe("summarizeRun", () => {
  test("aggregates pass/fail and metrics", () => {
    const s = summarizeRun([
      sampleResult({ passed: true, turnsUsed: 2, toolCallCount: 3, durationMs: 100 }),
      sampleResult({
        id: "complex-jwt",
        passed: false,
        turnsUsed: 4,
        toolCallCount: 7,
        durationMs: 200,
        tokenUsage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      }),
    ]);
    expect(s.total).toBe(2);
    expect(s.passed).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.durationMs).toBe(300);
    expect(s.turnsUsed).toBe(6);
    expect(s.toolCallCount).toBe(10);
    expect(s.tokenUsage.input).toBe(110);
    expect(s.tokenUsage.output).toBe(70);
  });
});

describe("evaluateSoftBudget", () => {
  test("null maxTurns means budget not in force", () => {
    expect(evaluateSoftBudget({ maxTurns: null, turnsUsed: 99 })).toEqual({
      overBudget: null,
      budgetError: null,
    });
  });

  test("fails closed when maxTurns set but turnsUsed missing", () => {
    const r = evaluateSoftBudget({ maxTurns: 10, turnsUsed: null });
    expect(r.overBudget).toBe(true);
    expect(r.budgetError).toMatch(/not reported/);
  });

  test("over budget when turns exceed max", () => {
    const r = evaluateSoftBudget({ maxTurns: 5, turnsUsed: 6 });
    expect(r.overBudget).toBe(true);
    expect(r.budgetError).toMatch(/over turn budget/);
  });

  test("within budget", () => {
    expect(evaluateSoftBudget({ maxTurns: 10, turnsUsed: 10 })).toEqual({
      overBudget: false,
      budgetError: null,
    });
  });
});

describe("computeCellAggregates", () => {
  test("aggregates repeats per cell with pass rate and behavior stats", () => {
    const results = [
      sampleResult({ repeat: 0, passed: true, behaviors: sampleBehaviors({ repeatedSearchCount: 1 }) }),
      sampleResult({ repeat: 1, passed: false, behaviors: sampleBehaviors({ repeatedSearchCount: 3 }) }),
      sampleResult({ repeat: 2, passed: true, behaviors: sampleBehaviors({ repeatedSearchCount: 2 }) }),
    ];
    const cells = computeCellAggregates(results);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.repeats).toBe(3);
    expect(cell.passCount).toBe(2);
    expect(cell.passRate).toBeCloseTo(2 / 3);
    expect(cell.behaviorStats.repeatedSearchCount).toEqual({ min: 1, median: 2, max: 3 });
  });

  test("skips behavior stats when no repeat captured behaviors", () => {
    const cells = computeCellAggregates([sampleResult({ behaviors: null })]);
    expect(cells[0]!.behaviorStats.repeatedSearchCount).toBeUndefined();
  });

  test("even repeat count uses midpoint median", () => {
    const cells = computeCellAggregates([
      sampleResult({ repeat: 0, behaviors: sampleBehaviors({ shellCommandCount: 2 }) }),
      sampleResult({ repeat: 1, behaviors: sampleBehaviors({ shellCommandCount: 4 }) }),
    ]);
    expect(cells[0]!.behaviorStats.shellCommandCount?.median).toBe(3);
  });
});

describe("compareToBaseline", () => {
  test("any pass-rate change is significant (improve/regress/new)", () => {
    const baseline = parseEvalRunReport({
      version: 3,
      provider: "xai",
      model: "grok",
      variants: [{ id: "xai/grok", provider: "xai", model: "grok" }],
      cases: [
        sampleResult({ id: "simple-health", variantId: "xai/grok", repeat: 0, passed: false }),
        sampleResult({ id: "simple-health", variantId: "xai/grok", repeat: 1, passed: true }),
        sampleResult({ id: "complex-jwt", variantId: "xai/grok", passed: true }),
      ],
    });
    const current = [
      sampleResult({ id: "simple-health", variantId: "xai/grok", repeat: 0, passed: true }),
      sampleResult({ id: "simple-health", variantId: "xai/grok", repeat: 1, passed: true }),
      sampleResult({ id: "complex-jwt", variantId: "xai/grok", passed: false }),
      sampleResult({ id: "new-case", variantId: "xai/grok", passed: true }),
    ];
    const cmp = compareToBaseline(current, baseline);
    expect(cmp.improved).toBe(1);
    expect(cmp.regressed).toBe(1);
    expect(cmp.added).toBe(1);
    const health = cmp.deltas.find((d) => d.id === "simple-health");
    expect(health?.previousPassRate).toBeCloseTo(0.5);
    expect(health?.currentPassRate).toBe(1);
    expect(health?.status).toBe("improved");
  });

  test("behavior medians produce improve/regress verdicts for lower-is-better metrics", () => {
    const baseline = parseEvalRunReport({
      version: 3,
      provider: "xai",
      model: "grok",
      cases: [
        sampleResult({
          variantId: "xai/grok",
          behaviors: sampleBehaviors({ repeatedSearchCount: 4, networkCommandCount: 0, shellCommandCount: 2 }),
        }),
      ],
    });
    const current = [
      sampleResult({
        variantId: "xai/grok",
        behaviors: sampleBehaviors({ repeatedSearchCount: 1, networkCommandCount: 2, shellCommandCount: 9 }),
      }),
    ];
    const cmp = compareToBaseline(current, baseline);
    const verdicts = cmp.deltas[0]!.behaviorVerdicts;
    const byMetric = new Map(verdicts.map((v) => [v.metric, v.verdict]));
    expect(byMetric.get("repeatedSearchCount")).toBe("improve");
    expect(byMetric.get("networkCommandCount")).toBe("regress");
    // Informational metric never produces a directional verdict.
    expect(byMetric.get("shellCommandCount")).toBe("neutral");
    expect(cmp.behaviorImproved).toBe(1);
    expect(cmp.behaviorRegressed).toBe(1);
  });

  test("flags a bait case whose baseline no longer reproduces its misbehavior", () => {
    const baitCase = sampleCase({
      id: "env-bait",
      tier: "bait",
      bait: { metric: "envAssignmentCommandCount", threshold: 0 },
    });
    const cleanBaseline = parseEvalRunReport({
      version: 3,
      provider: "xai",
      model: "grok",
      cases: [
        sampleResult({
          id: "env-bait",
          variantId: "xai/grok",
          behaviors: sampleBehaviors({ envAssignmentCommandCount: 0 }),
        }),
      ],
    });
    const current = [
      sampleResult({
        id: "env-bait",
        variantId: "xai/grok",
        behaviors: sampleBehaviors({ envAssignmentCommandCount: 0 }),
      }),
    ];
    const cmp = compareToBaseline(current, cleanBaseline, [baitCase]);
    expect(cmp.baitFlags).toBe(1);
    expect(cmp.deltas[0]!.baitNotReproducing).toMatch(/envAssignmentCommandCount/);
  });

  test("does not flag a bait case that reproduces on baseline", () => {
    const baitCase = sampleCase({
      id: "env-bait",
      tier: "bait",
      bait: { metric: "envAssignmentCommandCount", threshold: 0 },
    });
    const baseline = parseEvalRunReport({
      version: 3,
      provider: "xai",
      model: "grok",
      cases: [
        sampleResult({
          id: "env-bait",
          variantId: "xai/grok",
          behaviors: sampleBehaviors({ envAssignmentCommandCount: 2 }),
        }),
      ],
    });
    const current = [
      sampleResult({
        id: "env-bait",
        variantId: "xai/grok",
        behaviors: sampleBehaviors({ envAssignmentCommandCount: 0 }),
      }),
    ];
    const cmp = compareToBaseline(current, baseline, [baitCase]);
    expect(cmp.baitFlags).toBe(0);
    expect(cmp.deltas[0]!.baitNotReproducing).toBeUndefined();
  });
});

describe("baitReproduces", () => {
  test("null when the metric was never captured", () => {
    const cell = computeCellAggregates([sampleResult({ behaviors: null })])[0]!;
    expect(baitReproduces(cell, { metric: "repeatedSearchCount", threshold: 0 })).toBeNull();
  });
});

describe("parseEvalRunReport", () => {
  test("round-trips repeat index and behaviors and recomputes aggregates", () => {
    const report = parseEvalRunReport({
      version: 3,
      provider: "xai",
      model: "grok",
      repeats: 2,
      cases: [
        sampleResult({ repeat: 0, behaviors: sampleBehaviors({ shellCommandCount: 2 }) }),
        sampleResult({ repeat: 1, behaviors: sampleBehaviors({ shellCommandCount: 4 }) }),
      ],
    });
    expect(report.repeats).toBe(2);
    expect(report.cases[0]!.behaviors?.shellCommandCount).toBe(2);
    expect(report.cases[1]!.repeat).toBe(1);
    expect(report.aggregates).toHaveLength(1);
    expect(report.aggregates[0]!.behaviorStats.shellCommandCount?.median).toBe(3);
  });

  test("legacy reports default repeat 0 and null behaviors", () => {
    const report = parseEvalRunReport({
      version: 2,
      provider: "xai",
      model: "grok",
      cases: [{ id: "simple-health", passed: true }],
    });
    expect(report.repeats).toBe(1);
    expect(report.cases[0]!.repeat).toBe(0);
    expect(report.cases[0]!.behaviors).toBeNull();
    expect(report.aggregates[0]!.passRate).toBe(1);
  });
});

describe("defaultVariantId / emptyTokenUsage", () => {
  test("helpers", () => {
    expect(defaultVariantId(undefined, undefined)).toBe("default:default");
    expect(emptyTokenUsage().input).toBe(0);
  });
});

describe("loadEvalCases (integration with tmp dir)", () => {
  test("loads case directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "corbits-eval-cases-"));
    try {
      const dir = join(root, "simple-health");
      await mkdir(dir);
      await writeFile(
        join(dir, "case.json"),
        JSON.stringify({
          id: "simple-health",
          tier: "simple",
          title: "Health",
          fixture: "tests/fixtures/x",
          prompt: "p",
        }),
      );
      await writeFile(join(dir, "verify.sh"), "#!/bin/bash\nexit 0\n");
      const { loadEvalCases } = await import("./lib.js");
      const cases = await loadEvalCases(root);
      expect(cases).toHaveLength(1);
      expect(cases[0]!.id).toBe("simple-health");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
