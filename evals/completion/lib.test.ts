import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CompletionReport,
  REPORT_VERSION,
  assertTaskSetContained,
  computeTotals,
  formatSummary,
  isCompletedRun,
  migrateLegacyCompletionReport,
  parseResponderScript,
  parseTaskSetFile,
  resolveTaskRelativePath,
  TaskResult,
  type CompletionReport as CompletionReportType,
  type TaskResult as TaskResultType,
} from "./lib.js";

const result = (overrides: Partial<TaskResultType> = {}): TaskResultType =>
  TaskResult.assert({
    taskId: "version-endpoint",
    title: "Add GET /version",
    profile: "solve",
    repeat: 0,
    completed: true,
    runStatus: "completed",
    turnsUsed: 3,
    turnsEstimated: false,
    toolCallCount: 2,
    failedToolCalls: 0,
    compactionEvents: 0,
    doomLoopInterventions: 0,
    thrashInterventions: 0,
    gateSuspensions: 0,
    agentDurationMs: 1200,
    verifyDurationMs: 300,
    verifyExitCode: 0,
    overBudget: false,
    ...overrides,
  });

describe("completion predicate", () => {
  test("completes only on clean run, green grader, and budget", () => {
    expect(isCompletedRun(result())).toBe(true);
    expect(isCompletedRun(result({ runStatus: "failed" }))).toBe(false);
    expect(isCompletedRun(result({ runStatus: "timeout" }))).toBe(false);
    expect(isCompletedRun(result({ verifyExitCode: 1 }))).toBe(false);
    expect(isCompletedRun(result({ overBudget: true }))).toBe(false);
  });
});

describe("completion totals", () => {
  test("mixed outcomes yield a fractional rate and completion-only turn mean", () => {
    const totals = computeTotals([
      result({ turnsUsed: 3, agentDurationMs: 1000, verifyDurationMs: 100 }),
      result({
        taskId: "stall-read",
        profile: "stall",
        completed: false,
        runStatus: "failed",
        turnsUsed: 4,
        toolCallCount: 4,
        failedToolCalls: 1,
        doomLoopInterventions: 1,
        verifyExitCode: 1,
        agentDurationMs: 3000,
        verifyDurationMs: 300,
      }),
    ]);
    expect(totals.tasksTotal).toBe(2);
    expect(totals.runsTotal).toBe(2);
    expect(totals.completedRuns).toBe(1);
    expect(totals.completionRate).toBe(0.5);
    expect(totals.meanTurnsToCompletion).toBe(3);
    expect(totals.meanAgentDurationMs).toBe(2000);
    expect(totals.meanVerifyDurationMs).toBe(200);
    expect(totals.totalFailedToolCalls).toBe(1);
    expect(totals.totalDoomLoopInterventions).toBe(1);
  });

  test("empty results stay zero without dividing by zero", () => {
    const totals = computeTotals([]);
    expect(totals.completionRate).toBe(0);
    expect(totals.meanTurnsToCompletion).toBe(0);
    expect(totals.meanAgentDurationMs).toBe(0);
    expect(totals.meanVerifyDurationMs).toBe(0);
    expect(totals.totalFailedToolCalls).toBe(0);
  });

  test("aggregates gate suspensions across runs", () => {
    const totals = computeTotals([
      result({ gateSuspensions: 2 }),
      result({ taskId: "stall-read", gateSuspensions: 3 }),
    ]);
    expect(totals.totalGateSuspensions).toBe(5);
  });
});

describe("boundary parsing", () => {
  test("rejects a task set with no tasks", () => {
    expect(() =>
      parseTaskSetFile({ version: 1, note: "x", tasks: [] }),
    ).toThrow();
  });

  test("rejects a responder script with no turns", () => {
    expect(() => parseResponderScript({ turns: [] })).toThrow();
  });

  test("rejects a report with an out-of-range completion rate", () => {
    const report = {
      harness: "completion-baseline",
      version: 1,
      startedAt: "2026-09-14T00:00:00.000Z",
      finishedAt: "2026-09-14T00:01:00.000Z",
      commitSha: "abc",
      provider: "stub-scripted",
      model: "completion-baseline-v1",
      repeats: 1,
      taskSetVersion: 1,
      taskIds: ["version-endpoint"],
      results: [result()],
      totals: { ...computeTotals([result()]), completionRate: 2 },
    };
    expect(() => CompletionReport.assert(report)).toThrow();
  });
});

describe("task path containment", () => {
  const root = "/repo/evals/completion";

  test("keeps relative fixture paths inside the harness directory", () => {
    expect(resolveTaskRelativePath(root, "tasks/sum-fix/fixture")).toBe(
      "/repo/evals/completion/tasks/sum-fix/fixture",
    );
  });

  test("rejects absolute escapes", () => {
    expect(() => resolveTaskRelativePath(root, "/etc/passwd")).toThrow(
      /escapes the harness directory/,
    );
  });

  test("rejects dot-dot escapes outside the harness directory", () => {
    expect(() => resolveTaskRelativePath(root, "../capability/lib.ts")).toThrow(
      /escapes the harness directory/,
    );
    expect(() =>
      resolveTaskRelativePath(root, "tasks/../../package.json"),
    ).toThrow(/escapes the harness directory/);
  });

  test("rejects an empty reference", () => {
    expect(() => resolveTaskRelativePath(root, "  ")).toThrow(
      /escapes the harness directory/,
    );
  });

  test("assertTaskSetContained rejects a task set with an escaped grader", () => {
    const taskSet = parseTaskSetFile({
      version: 1,
      note: "x",
      tasks: [
        {
          id: "evil",
          title: "evil",
          profile: "solve",
          prompt: "p",
          fixture: "tasks/sum-fix/fixture",
          script: "tasks/sum-fix/script.json",
          verify: "/tmp/evil.sh",
          maxTurns: 1,
        },
      ],
    });
    expect(() => assertTaskSetContained(taskSet, root)).toThrow(
      /escapes the harness directory/,
    );
  });
});

describe("human summary", () => {
  test("names the harness, provenance, rate, and every run", () => {
    const results = [
      result(),
      result({ taskId: "stall-read", completed: false, turnsEstimated: true }),
    ];
    const report: CompletionReportType = CompletionReport.assert({
      harness: "completion-baseline",
      version: REPORT_VERSION,
      startedAt: "2026-09-14T00:00:00.000Z",
      finishedAt: "2026-09-14T00:01:00.000Z",
      commitSha: "deadbeef",
      provider: "stub-scripted",
      model: "completion-baseline-v1",
      repeats: 1,
      taskSetVersion: 1,
      taskIds: ["version-endpoint", "stall-read"],
      results,
      totals: computeTotals(results),
    });
    const summary = formatSummary(report);
    expect(summary).toContain("completion rate 50.0% (1/2 runs)");
    expect(summary).toContain("deadbeef");
    expect(summary).toContain("stub-scripted");
    expect(summary).toContain("mean verify time 300ms");
    expect(summary).toContain("failed tool calls 0");
    expect(summary).not.toContain("retries");
    expect(summary).toContain("version-endpoint r0: complete");
    expect(summary).toContain("stall-read r0: incomplete");
    expect(summary).toContain("turns 3 (estimated)");
    expect(summary).toContain("verify 300ms");
  });
});

describe("legacy v1 migration", () => {
  const legacyResult = (overrides: Record<string, unknown> = {}) => ({
    taskId: "version-endpoint",
    title: "Add GET /version",
    profile: "solve",
    repeat: 0,
    completed: true,
    runStatus: "completed",
    turnsUsed: 3,
    toolCallCount: 2,
    failedToolCalls: 0,
    retryCount: 0,
    compactionEvents: 0,
    doomLoopInterventions: 0,
    thrashInterventions: 0,
    gateSuspensions: 0,
    agentDurationMs: 1200,
    verifyDurationMs: 300,
    verifyExitCode: 0,
    overBudget: false,
    ...overrides,
  });

  const legacyReport = (results: Record<string, unknown>[]) => ({
    harness: "completion-baseline",
    version: 1,
    startedAt: "2026-09-14T00:00:00.000Z",
    finishedAt: "2026-09-14T00:01:00.000Z",
    commitSha: "deadbeef",
    provider: "stub-scripted",
    model: "completion-baseline-v1",
    repeats: 1,
    taskSetVersion: 1,
    taskIds: ["version-endpoint"],
    results,
    totals: {
      tasksTotal: 1,
      runsTotal: results.length,
      completedRuns: 1,
      completionRate: 1,
      meanTurnsToCompletion: 3,
      meanAgentDurationMs: 1200,
      totalRetries: 0,
      totalCompactionEvents: 0,
      totalDoomLoopInterventions: 0,
      totalThrashInterventions: 0,
      totalGateSuspensions: 0,
    },
  });

  test("drops the mislabeled retry count and aggregates verify durations", () => {
    const migrated = migrateLegacyCompletionReport(
      legacyReport([legacyResult(), legacyResult({ repeat: 1 })]),
    );
    expect(migrated.version).toBe(REPORT_VERSION);
    expect(migrated.totals.totalFailedToolCalls).toBe(0);
    expect(migrated.totals.meanVerifyDurationMs).toBe(300);
    for (const migratedResult of migrated.results) {
      expect("retryCount" in migratedResult).toBe(false);
      expect("turnsEstimated" in migratedResult).toBe(false);
    }
  });

  test("rejects a legacy result whose retry count is not a failure count", () => {
    expect(() =>
      migrateLegacyCompletionReport(
        legacyReport([legacyResult({ retryCount: 2, failedToolCalls: 1 })]),
      ),
    ).toThrow(/mislabels retries/);
  });

  test("rejects a non-v1 report", () => {
    const payload = legacyReport([legacyResult()]);
    payload.version = REPORT_VERSION;
    expect(() => migrateLegacyCompletionReport(payload)).toThrow(
      /Only v1 reports can be migrated/,
    );
  });
});

describe("checked-in baseline", () => {
  test("the frozen v1 baseline migrates to the current report schema", async () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(dir, "baseline-2026-09-14.json"), "utf8");
    const report = migrateLegacyCompletionReport(JSON.parse(raw));
    expect(report.totals.runsTotal).toBe(report.results.length);
    expect(report.totals.runsTotal).toBe(8);
    expect(report.totals.completionRate).toBe(0.5);
    expect(report.totals.totalFailedToolCalls).toBe(0);
    expect(report.totals.meanVerifyDurationMs).toBe(120.75);
  });

  test("prints the aggregated gate suspensions", () => {
    const results = [
      result({ gateSuspensions: 2 }),
      result({ taskId: "stall-read", gateSuspensions: 3 }),
    ];
    const report: CompletionReportType = CompletionReport.assert({
      harness: "completion-baseline",
      version: 1,
      startedAt: "2026-09-14T00:00:00.000Z",
      finishedAt: "2026-09-14T00:01:00.000Z",
      commitSha: "deadbeef",
      provider: "stub-scripted",
      model: "completion-baseline-v1",
      repeats: 1,
      taskSetVersion: 1,
      taskIds: ["version-endpoint", "stall-read"],
      results,
      totals: computeTotals(results),
    });
    expect(formatSummary(report)).toContain("gate suspensions 5");
  });
});
