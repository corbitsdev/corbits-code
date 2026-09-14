import { describe, expect, test } from "bun:test";
import {
  CompletionReport,
  computeTotals,
  formatSummary,
  isCompletedRun,
  parseResponderScript,
  parseTaskSetFile,
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
      result({ turnsUsed: 3, agentDurationMs: 1000 }),
      result({
        taskId: "stall-read",
        profile: "stall",
        completed: false,
        runStatus: "failed",
        turnsUsed: 4,
        toolCallCount: 4,
        retryCount: 1,
        doomLoopInterventions: 1,
        verifyExitCode: 1,
        agentDurationMs: 3000,
      }),
    ]);
    expect(totals.tasksTotal).toBe(2);
    expect(totals.runsTotal).toBe(2);
    expect(totals.completedRuns).toBe(1);
    expect(totals.completionRate).toBe(0.5);
    expect(totals.meanTurnsToCompletion).toBe(3);
    expect(totals.meanAgentDurationMs).toBe(2000);
    expect(totals.totalRetries).toBe(1);
    expect(totals.totalDoomLoopInterventions).toBe(1);
  });

  test("empty results stay zero without dividing by zero", () => {
    const totals = computeTotals([]);
    expect(totals.completionRate).toBe(0);
    expect(totals.meanTurnsToCompletion).toBe(0);
    expect(totals.meanAgentDurationMs).toBe(0);
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

describe("human summary", () => {
  test("names the harness, provenance, rate, and every run", () => {
    const results = [
      result(),
      result({ taskId: "stall-read", completed: false }),
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
    const summary = formatSummary(report);
    expect(summary).toContain("completion rate 50.0% (1/2 runs)");
    expect(summary).toContain("deadbeef");
    expect(summary).toContain("stub-scripted");
    expect(summary).toContain("version-endpoint r0: complete");
    expect(summary).toContain("stall-read r0: incomplete");
  });
});
