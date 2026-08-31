import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
  checkBehaviorRequirements,
  computeCellAggregates,
  baitReproduces,
  httpFixtureEnv,
  withEnv,
  evalHttpEnvGet,
  detectProviderFallback,
  formatProviderFallback,
  resolveRequestedProviderModel,
  type CaseResult,
  type EvalCase,
} from "./lib.js";
import type { BehaviorMetrics } from "./behaviors.js";

function sampleCase(over: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "simple-health",
    tier: "easy",
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
    tier: over.tier ?? "easy",
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
    tokenUsage: over.tokenUsage ?? {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    },
    skipPermissions: over.skipPermissions ?? true,
    error: over.error ?? null,
    repeat: over.repeat ?? 0,
    behaviors: over.behaviors ?? null,
    providerFallback: over.providerFallback ?? null,
    diagnostics: over.diagnostics ?? null,
    effort: over.effort ?? null,
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
    spawnAgentToolCallCount: 0,
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
        tier: "easy",
        title: "Health",
        fixture: "tests/fixtures/x",
        prompt: "add health",
      },
      "/cases/simple-health",
    );
    expect(c.id).toBe("simple-health");
    expect(c.verify).toBe("verify.sh");
  });

  test("parses a bait case with http fixture", () => {
    const c = parseCaseJson(
      {
        id: "web-bait",
        tier: "med",
        title: "Web bait",
        fixture: "tests/fixtures/web-note",
        prompt: "fetch {{HTTP_URL}}",
        httpFixture: true,
        bait: { metric: "networkCommandCount", threshold: 0 },
      },
      "/cases/web-bait",
    );
    expect(c.tier).toBe("med");
    expect(c.httpFixture).toBe(true);
    expect(c.bait).toEqual({ metric: "networkCommandCount", threshold: 0 });
  });

  test("rejects an unknown bait metric", () => {
    expect(() =>
      parseCaseJson(
        {
          id: "x",
          tier: "med",
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
          tier: "med",
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
          tier: "impossible",
          title: "t",
          fixture: "f",
          prompt: "p",
        },
        "/c",
      ),
    ).toThrow(/tier/);
  });

  test("parses requireBehaviors", () => {
    const c = parseCaseJson(
      {
        id: "web-bait",
        tier: "med",
        title: "Web bait",
        fixture: "tests/fixtures/web-note",
        prompt: "fetch",
        requireBehaviors: [{ metric: "webFetchToolCallCount", min: 1 }],
      },
      "/cases/web-bait",
    );
    expect(c.requireBehaviors).toEqual([{ metric: "webFetchToolCallCount", min: 1 }]);
  });

  test("rejects unknown requireBehaviors metric", () => {
    expect(() =>
      parseCaseJson(
        {
          id: "x",
          tier: "easy",
          title: "t",
          fixture: "f",
          prompt: "p",
          requireBehaviors: [{ metric: "notAMetric", min: 1 }],
        },
        "/c",
      ),
    ).toThrow(/requireBehaviors\[0\]\.metric/);
  });

  test("rejects requireBehaviors without min or max", () => {
    expect(() =>
      parseCaseJson(
        {
          id: "x",
          tier: "easy",
          title: "t",
          fixture: "f",
          prompt: "p",
          requireBehaviors: [{ metric: "webFetchToolCallCount" }],
        },
        "/c",
      ),
    ).toThrow(/at least one of min or max/);
  });

  test("rejects requireBehaviors when min > max", () => {
    expect(() =>
      parseCaseJson(
        {
          id: "x",
          tier: "easy",
          title: "t",
          fixture: "f",
          prompt: "p",
          requireBehaviors: [{ metric: "webFetchToolCallCount", min: 5, max: 1 }],
        },
        "/c",
      ),
    ).toThrow(/min \(5\) must be <= max \(1\)/);
  });
});

describe("checkBehaviorRequirements", () => {
  test("passes when reqs empty", () => {
    expect(checkBehaviorRequirements(null, [])).toEqual({ ok: true, failures: [] });
  });

  test("fails when capture missing and reqs non-empty", () => {
    const r = checkBehaviorRequirements(null, [{ metric: "webFetchToolCallCount", min: 1 }]);
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/capture missing/);
  });

  test("fails when metric below min", () => {
    const r = checkBehaviorRequirements(sampleBehaviors({ webFetchToolCallCount: 0 }), [
      { metric: "webFetchToolCallCount", min: 1 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(["webFetchToolCallCount=0 below min 1"]);
  });

  test("fails when metric above max", () => {
    const r = checkBehaviorRequirements(sampleBehaviors({ networkCommandCount: 3 }), [
      { metric: "networkCommandCount", max: 0 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(["networkCommandCount=3 above max 0"]);
  });

  test("passes when within bounds", () => {
    const r = checkBehaviorRequirements(sampleBehaviors({ webFetchToolCallCount: 2 }), [
      { metric: "webFetchToolCallCount", min: 1, max: 5 },
    ]);
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });
});

describe("filterCases", () => {
  test("all returns everything", () => {
    const cases = [sampleCase(), sampleCase({ id: "complex-jwt", tier: "hard" })];
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

  test("rejects incomplete cells", () => {
    expect(() => parseMatrix("xai:", {})).toThrow(/both provider and model/);
    expect(() => parseMatrix(":grok-4.5", {})).toThrow(/both provider and model/);
  });

  test("fills omitted cell side from --provider/--model defaults", () => {
    const v = parseMatrix("xai:", { model: "grok-4.5" });
    expect(v[0]).toEqual({ id: "xai:grok-4.5", provider: "xai", model: "grok-4.5" });
  });

  test("parses a third colon segment as effort", () => {
    const v = parseMatrix("xai/thegreataxios:grok-4.6:xhigh", {});
    expect(v[0]).toEqual({
      id: "xai/thegreataxios:grok-4.6",
      provider: "xai/thegreataxios",
      model: "grok-4.6",
      effort: "xhigh",
    });
  });

  test("labeled cell can also carry an effort segment", () => {
    const v = parseMatrix("fast=xai:grok-4.6:high", {});
    expect(v[0]).toEqual({ id: "fast", provider: "xai", model: "grok-4.6", effort: "high" });
  });

  test("a trailing segment that is not a real effort literal falls through to the model", () => {
    // "grok-4.6:not-an-effort" has no valid effort literal in the third slot,
    // so the whole thing after the first colon is the model id.
    const v = parseMatrix("xai:grok-4.6:not-an-effort", {});
    expect(v[0]!.provider).toBe("xai");
    expect(v[0]!.model).toBe("grok-4.6:not-an-effort");
    expect(v[0]!.effort).toBeUndefined();
  });

  test("--effort fallback applies to a cell that doesn't specify its own", () => {
    const v = parseMatrix("xai:grok-4.6,openai:gpt-5", { effort: "medium" });
    expect(v[0]!.effort).toBe("medium");
    expect(v[1]!.effort).toBe("medium");
  });

  test("a cell's own effort wins over the --effort fallback", () => {
    const v = parseMatrix("xai:grok-4.6:high", { effort: "medium" });
    expect(v[0]!.effort).toBe("high");
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

describe("computeCellAggregates", () => {
  test("aggregates repeats per cell with pass rate and behavior stats", () => {
    const results = [
      sampleResult({
        repeat: 0,
        passed: true,
        behaviors: sampleBehaviors({ repeatedSearchCount: 1 }),
      }),
      sampleResult({
        repeat: 1,
        passed: false,
        behaviors: sampleBehaviors({ repeatedSearchCount: 3 }),
      }),
      sampleResult({
        repeat: 2,
        passed: true,
        behaviors: sampleBehaviors({ repeatedSearchCount: 2 }),
      }),
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
          behaviors: sampleBehaviors({
            repeatedSearchCount: 4,
            networkCommandCount: 0,
            shellCommandCount: 2,
          }),
        }),
      ],
    });
    const current = [
      sampleResult({
        variantId: "xai/grok",
        behaviors: sampleBehaviors({
          repeatedSearchCount: 1,
          networkCommandCount: 2,
          shellCommandCount: 9,
        }),
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
      tier: "med",
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
      tier: "med",
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

describe("detectProviderFallback", () => {
  test("null when resolved matches requested", () => {
    expect(
      detectProviderFallback({
        requestedProvider: "xai",
        requestedModel: "grok-4.5",
        resolvedProvider: "xai",
        resolvedModel: "grok-4.5",
      }),
    ).toBeNull();
  });

  test("null when nothing specific was requested", () => {
    expect(
      detectProviderFallback({
        resolvedProvider: "xai",
        resolvedModel: "grok-4.5",
      }),
    ).toBeNull();
  });

  test("flags a model mismatch even when provider matches", () => {
    const info = detectProviderFallback({
      requestedProvider: "xai",
      requestedModel: "grok-4.5",
      resolvedProvider: "xai",
      resolvedModel: "grok-4.0",
    });
    expect(info).toEqual({
      requestedProvider: "xai",
      requestedModel: "grok-4.5",
      resolvedProvider: "xai",
      resolvedModel: "grok-4.0",
    });
  });

  test("flags a provider mismatch", () => {
    const info = detectProviderFallback({
      requestedProvider: "xai",
      resolvedProvider: "openai",
      resolvedModel: "gpt-4.1",
    });
    expect(info?.requestedProvider).toBe("xai");
    expect(info?.resolvedProvider).toBe("openai");
  });

  test("formatProviderFallback names both requested and resolved", () => {
    const info = detectProviderFallback({
      requestedProvider: "xai",
      requestedModel: "grok-4.5",
      resolvedProvider: "openai",
      resolvedModel: "gpt-4.1",
    });
    expect(info).not.toBeNull();
    const message = formatProviderFallback(info!);
    expect(message).toContain("xai/grok-4.5");
    expect(message).toContain("openai/gpt-4.1");
  });
});

describe("resolveRequestedProviderModel", () => {
  // Regression fixture (evals/capability/regression-fixtures/probe-provider-mismatch.json):
  // reconstructed from a live probe run that was launched with no
  // --provider/--model flags at all, relying on this repo's local
  // .corbits/settings.json to pick xai/grok-4.5 (report.provider/model,
  // populated by resolveVariantLabels' catalog/OAuth-aware loadConfig probe —
  // exactly the shape passed here as `labels`). The unlabeled default matrix cell
  // never carries its own provider/model, and it silently resolved to
  // zen/north-mini-code-free with providerFallback recorded as null and a zero
  // exit — the exact silent substitution the gate exists to catch. Comparing the
  // resolved provider/model against the variant's own fields (or against the raw
  // --provider/--model flags, which were never passed) misses this entirely; the
  // check must fall back to the run's resolved labels. The live artifact under
  // evals/capability/results/ is regenerated by every run and gitignored, so this
  // fixture lives outside that directory to stay stable.
  test("a live probe artifact's default-cell mismatch is detected against the run's resolved labels", async () => {
    const fixturePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "regression-fixtures",
      "probe-provider-mismatch.json",
    );
    const raw = JSON.parse(await readFile(fixturePath, "utf8")) as {
      provider: string;
      model: string;
      variants: { id: string; provider?: string; model?: string }[];
      cases: { provider: string; model: string; variantId: string }[];
    };
    const variant = raw.variants.find((v) => v.id === "default:default");
    expect(variant).toBeDefined();
    expect(variant?.provider).toBeUndefined();
    expect(variant?.model).toBeUndefined();

    const cell = raw.cases[0];
    expect(cell).toBeDefined();

    const requested = resolveRequestedProviderModel(variant!, {
      provider: raw.provider,
      model: raw.model,
    });
    expect(requested).toEqual({ provider: raw.provider, model: raw.model });

    const fallback = detectProviderFallback({
      ...(requested.provider !== undefined ? { requestedProvider: requested.provider } : {}),
      ...(requested.model !== undefined ? { requestedModel: requested.model } : {}),
      resolvedProvider: cell!.provider,
      resolvedModel: cell!.model,
    });
    expect(fallback).not.toBeNull();
    expect(fallback?.requestedProvider).toBe("xai/thegreataxios");
    expect(fallback?.requestedModel).toBe("grok-4.5");
    expect(fallback?.resolvedProvider).toBe("zen");
    expect(fallback?.resolvedModel).toBe("north-mini-code-free");
    const message = formatProviderFallback(fallback!);
    expect(message).toContain("xai/thegreataxios/grok-4.5");
    expect(message).toContain("zen/north-mini-code-free");
  });

  test("a matrix cell's own override wins over the run's resolved labels", () => {
    const requested = resolveRequestedProviderModel(
      { provider: "openai", model: "gpt-4.1" },
      { provider: "xai", model: "grok-4.5" },
    );
    expect(requested).toEqual({ provider: "openai", model: "gpt-4.1" });
  });

  test("the '(default)' placeholder from an unresolvable ambient probe is not a real request", () => {
    const requested = resolveRequestedProviderModel(
      {},
      { provider: "(default)", model: "(default)" },
    );
    expect(requested).toEqual({});
  });
});

describe("compareToBaseline provider/model guard", () => {
  test("refuses to compare cells that resolved to different models", () => {
    const baseline = parseEvalRunReport({
      version: 3,
      provider: "xai",
      model: "grok-4.5",
      cases: [sampleResult({ variantId: "xai/grok-4.5", provider: "xai", model: "grok-4.5" })],
    });
    const current = [
      sampleResult({ variantId: "xai/grok-4.5", provider: "xai", model: "grok-4.0" }),
    ];
    expect(() => compareToBaseline(current, baseline)).toThrow(
      /different resolved model|cannot compare baseline/,
    );
  });

  test("allows the comparison when --allow-provider-fallback is set", () => {
    const baseline = parseEvalRunReport({
      version: 3,
      provider: "xai",
      model: "grok-4.5",
      cases: [sampleResult({ variantId: "xai/grok-4.5", provider: "xai", model: "grok-4.5" })],
    });
    const current = [
      sampleResult({ variantId: "xai/grok-4.5", provider: "xai", model: "grok-4.0" }),
    ];
    const cmp = compareToBaseline(current, baseline, [], { allowProviderFallback: true });
    expect(cmp.deltas).toHaveLength(1);
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

  test("round-trips providerFallback stamping on a case result", () => {
    const report = parseEvalRunReport({
      version: 3,
      provider: "xai",
      model: "grok",
      cases: [
        sampleResult({
          providerFallback: {
            requestedProvider: "xai",
            requestedModel: "grok-4.5",
            resolvedProvider: "xai",
            resolvedModel: "grok-4.0",
          },
        }),
      ],
    });
    expect(report.cases[0]!.providerFallback).toEqual({
      requestedProvider: "xai",
      requestedModel: "grok-4.5",
      resolvedProvider: "xai",
      resolvedModel: "grok-4.0",
    });
  });

  test("round-trips diagnostics stamping on a case result", () => {
    const report = parseEvalRunReport({
      version: 3,
      provider: "xai",
      model: "grok",
      cases: [
        sampleResult({
          diagnostics: {
            codexInstructionsHash: "abc123def456",
            advertisedTools: ["read_file", "run_shell"],
            reasoningEffort: "high",
          },
        }),
      ],
    });
    expect(report.cases[0]!.diagnostics).toEqual({
      codexInstructionsHash: "abc123def456",
      advertisedTools: ["read_file", "run_shell"],
      reasoningEffort: "high",
    });
  });

  test("legacy reports with no diagnostics parse to null", () => {
    const report = parseEvalRunReport({
      version: 3,
      provider: "xai",
      model: "grok",
      cases: [sampleResult()],
    });
    expect(report.cases[0]!.diagnostics).toBeNull();
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
          tier: "easy",
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

describe("withEnv / httpFixtureEnv", () => {
  // The absent-variable case is a precondition of these tests, not something
  // inherited from the shell or from whatever ran earlier in this process.
  beforeEach(() => {
    delete process.env.EVAL_HTTP_URL;
  });

  test("makes the fixture origin visible to in-process code the way ssrf-guard reads it", async () => {
    const fixture = { url: "http://127.0.0.1:54321/", token: "tok" };
    expect(evalHttpEnvGet("EVAL_HTTP_URL")).toBeUndefined();
    expect(process.env.EVAL_HTTP_URL).toBeUndefined();
    let seenDuring: string | undefined;
    await withEnv(httpFixtureEnv(fixture), async () => {
      seenDuring = evalHttpEnvGet("EVAL_HTTP_URL");
      expect(process.env.EVAL_HTTP_URL).toBeUndefined();
    });
    expect(seenDuring).toBe(fixture.url);
    expect(evalHttpEnvGet("EVAL_HTTP_URL")).toBeUndefined();
    expect(process.env.EVAL_HTTP_URL).toBeUndefined();
  });

  test("overlay does not leak after throw and leaves process.env untouched", async () => {
    process.env.EVAL_HTTP_URL = "http://pre-existing/";
    try {
      await expect(
        withEnv({ EVAL_HTTP_URL: "http://127.0.0.1:1/" }, async () => {
          expect(evalHttpEnvGet("EVAL_HTTP_URL")).toBe("http://127.0.0.1:1/");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(process.env.EVAL_HTTP_URL).toBe("http://pre-existing/");
      expect(evalHttpEnvGet("EVAL_HTTP_URL")).toBe("http://pre-existing/");
    } finally {
      delete process.env.EVAL_HTTP_URL;
    }
  });
});
