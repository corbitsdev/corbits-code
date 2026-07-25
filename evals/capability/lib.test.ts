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
  type CaseResult,
  type EvalCase,
} from "./lib.js";

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

describe("compareToBaseline", () => {
  test("detects improve/regress/new by resultKey", () => {
    const baseline = parseEvalRunReport({
      version: 2,
      provider: "xai",
      model: "grok",
      variants: [{ id: "xai/grok", provider: "xai", model: "grok" }],
      cases: [
        sampleResult({ id: "simple-health", variantId: "xai/grok", passed: false }),
        sampleResult({ id: "complex-jwt", variantId: "xai/grok", passed: true }),
      ],
    });
    const current = [
      sampleResult({ id: "simple-health", variantId: "xai/grok", passed: true }),
      sampleResult({ id: "complex-jwt", variantId: "xai/grok", passed: false }),
      sampleResult({ id: "new-case", variantId: "xai/grok", passed: true }),
    ];
    const cmp = compareToBaseline(current, baseline);
    expect(cmp.improved).toBe(1);
    expect(cmp.regressed).toBe(1);
    expect(cmp.added).toBe(1);
  });

  test("includes metric deltas when both tracked", () => {
    const baseline = parseEvalRunReport({
      version: 2,
      provider: "xai",
      model: "grok",
      cases: [
        sampleResult({
          id: "simple-health",
          variantId: "xai/grok",
          durationMs: 1000,
          turnsUsed: 5,
          tokenUsage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        }),
      ],
    });
    const current = [
      sampleResult({
        id: "simple-health",
        variantId: "xai/grok",
        durationMs: 800,
        turnsUsed: 3,
        tokenUsage: { input: 90, output: 30, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      }),
    ];
    const cmp = compareToBaseline(current, baseline);
    expect(cmp.deltas[0]!.metrics?.durationMsDelta).toBe(-200);
    expect(cmp.deltas[0]!.metrics?.turnsUsedDelta).toBe(-2);
    expect(cmp.deltas[0]!.metrics?.tokenOutputDelta).toBe(-10);
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
