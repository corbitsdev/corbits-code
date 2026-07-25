import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCaseJson,
  filterCases,
  resolveFixturePath,
  compareToBaseline,
  parseEvalRunReport,
  summarizeRun,
  loadEvalCases,
  type EvalCase,
  type CaseResult,
  type EvalRunReport,
} from "./lib.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CASES_ROOT = join(REPO_ROOT, "evals", "capability", "cases");

function sampleCase(over: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "sample",
    tier: "simple",
    title: "Sample",
    fixture: "tests/fixtures/multi-file-service",
    prompt: "do the thing",
    verify: "verify.sh",
    caseDir: "/tmp/sample",
    ...over,
  };
}

describe("parseCaseJson", () => {
  test("accepts a valid case object", () => {
    const c = parseCaseJson(
      {
        id: "simple-health",
        tier: "simple",
        title: "Health",
        fixture: "tests/fixtures/multi-file-service",
        prompt: "add health",
        maxTurns: 12,
      },
      "/tmp/simple-health",
    );
    expect(c.id).toBe("simple-health");
    expect(c.maxTurns).toBe(12);
    expect(c.verify).toBe("verify.sh");
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
        "/tmp/x",
      ),
    ).toThrow(/tier/);
  });
});

describe("loadEvalCases", () => {
  test("loads checked-in simple and complex cases", async () => {
    const cases = await loadEvalCases(CASES_ROOT);
    const ids = cases.map((c) => c.id).sort();
    expect(ids).toContain("simple-health");
    expect(ids).toContain("complex-jwt");
    expect(cases.find((c) => c.id === "simple-health")?.tier).toBe("simple");
    expect(cases.find((c) => c.id === "complex-jwt")?.tier).toBe("complex");
  });
});

describe("filterCases", () => {
  const cases = [sampleCase({ id: "a" }), sampleCase({ id: "b", tier: "complex" })];

  test("all returns every case", () => {
    expect(filterCases(cases, "all").map((c) => c.id)).toEqual(["a", "b"]);
  });

  test("selects by id", () => {
    expect(filterCases(cases, "b").map((c) => c.id)).toEqual(["b"]);
  });

  test("throws on unknown id", () => {
    expect(() => filterCases(cases, "nope")).toThrow(/Unknown case/);
  });
});

describe("resolveFixturePath", () => {
  test("resolves under repo root", () => {
    const abs = resolveFixturePath(REPO_ROOT, "tests/fixtures/multi-file-service");
    expect(abs.startsWith(REPO_ROOT)).toBe(true);
  });

  test("rejects escape", () => {
    expect(() => resolveFixturePath(REPO_ROOT, "../outside")).toThrow(/escapes/);
  });
});

describe("compareToBaseline", () => {
  const current: CaseResult[] = [
    {
      id: "a",
      tier: "simple",
      title: "A",
      passed: true,
      agentExitCode: 0,
      verifyExitCode: 0,
      durationMs: 1,
      error: null,
    },
    {
      id: "b",
      tier: "complex",
      title: "B",
      passed: false,
      agentExitCode: 1,
      verifyExitCode: 1,
      durationMs: 2,
      error: "fail",
    },
    {
      id: "c",
      tier: "simple",
      title: "C",
      passed: true,
      agentExitCode: 0,
      verifyExitCode: 0,
      durationMs: 3,
      error: null,
    },
  ];

  const baseline: EvalRunReport = {
    version: 1,
    startedAt: "t0",
    finishedAt: "t1",
    provider: "p",
    model: "m",
    cases: [
      { ...current[0]!, passed: false },
      { ...current[1]!, passed: true },
    ],
  };

  test("detects improve / regress / new", () => {
    const cmp = compareToBaseline(current, baseline);
    expect(cmp.improved).toBe(1);
    expect(cmp.regressed).toBe(1);
    expect(cmp.added).toBe(1);
    expect(cmp.deltas.find((d) => d.id === "a")?.status).toBe("improved");
    expect(cmp.deltas.find((d) => d.id === "b")?.status).toBe("regressed");
    expect(cmp.deltas.find((d) => d.id === "c")?.status).toBe("new");
  });
});

describe("parseEvalRunReport / summarizeRun", () => {
  test("parses version 1 reports", () => {
    const report = parseEvalRunReport({
      version: 1,
      startedAt: "a",
      finishedAt: "b",
      provider: "p",
      model: "m",
      cases: [],
    });
    expect(report.version).toBe(1);
  });

  test("summarize counts", () => {
    const s = summarizeRun([
      {
        id: "a",
        tier: "simple",
        title: "A",
        passed: true,
        agentExitCode: 0,
        verifyExitCode: 0,
        durationMs: 1,
        error: null,
      },
      {
        id: "b",
        tier: "simple",
        title: "B",
        passed: false,
        agentExitCode: 1,
        verifyExitCode: 1,
        durationMs: 1,
        error: "x",
      },
    ]);
    expect(s).toEqual({ passed: 1, failed: 1, total: 2 });
  });
});
