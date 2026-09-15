/**
 * Pure helpers for the CL-7932 task-completion baseline harness.
 * No process I/O here: the runner (scripts/eval-completion.ts) owns the
 * filesystem, child processes, and the agent loop; this module owns the
 * shapes at the boundary (arktype) plus completion math and the summary.
 *
 * TRUST BOUNDARY: the version-controlled task and grading files under
 * evals/completion/tasks/ (tasks.json, per-task script.json, verify.sh, and
 * fixture/ copies) plus evals/completion/lib.ts and
 * scripts/eval-completion.ts are the trusted grading boundary. Treat edits to
 * those paths as grading changes requiring owner review; custom --tasks JSON
 * passed on the CLI is untrusted input and its fixture/script/verify
 * references stay confined to evals/completion/ via
 * resolveTaskRelativePath (absolute paths and `..` escapes are rejected).
 */

import { isAbsolute, relative, resolve } from "node:path";
import { type } from "arktype";

export const ResponderProfile = type("'solve' | 'decline' | 'stall'");
export type ResponderProfile = typeof ResponderProfile.infer;

export const CompletionTask = type({
  id: "string",
  title: "string",
  profile: ResponderProfile,
  prompt: "string",
  fixture: "string",
  script: "string",
  verify: "string",
  maxTurns: "number.integer >= 1",
});
export type CompletionTask = typeof CompletionTask.infer;

export const CompletionTaskSet = type({
  version: "number.integer >= 1",
  note: "string",
  tasks: CompletionTask.array().atLeastLength(1),
});
export type CompletionTaskSet = typeof CompletionTaskSet.infer;

export const ScriptedToolCall = type({
  name: "string",
  // Required, not optional: replyOnce's ReplyOnceToolCall needs args, and
  // exactOptionalPropertyTypes rejects an optional-unknown against it.
  args: "unknown",
});
export type ScriptedToolCall = typeof ScriptedToolCall.infer;

export const ScriptedTurn = type({
  "text?": "string",
  "toolCalls?": ScriptedToolCall.array(),
});
export type ScriptedTurn = typeof ScriptedTurn.infer;

export const ResponderScript = type({
  turns: ScriptedTurn.array().atLeastLength(1),
});
export type ResponderScript = typeof ResponderScript.infer;

export const RunStatus = type("'completed' | 'failed' | 'timeout'");
export type RunStatus = typeof RunStatus.infer;

export const TaskResult = type({
  taskId: "string",
  title: "string",
  profile: ResponderProfile,
  repeat: "number.integer >= 0",
  completed: "boolean",
  runStatus: RunStatus,
  turnsUsed: "number.integer >= 0",
  // Absent on v1 reports recorded before estimation tracking: there the
  // turnsUsed provenance is unknown, so migration leaves it unset rather
  // than guessing.
  "turnsEstimated?": "boolean",
  toolCallCount: "number.integer >= 0",
  // Failed tool calls, not retries: v1 called this retryCount, which
  // mislabeled the count. The loop never re-issues a failed call, so the
  // honest name is the failure count itself.
  failedToolCalls: "number.integer >= 0",
  compactionEvents: "number.integer >= 0",
  doomLoopInterventions: "number.integer >= 0",
  thrashInterventions: "number.integer >= 0",
  gateSuspensions: "number.integer >= 0",
  agentDurationMs: "number.integer >= 0",
  verifyDurationMs: "number.integer >= 0",
  verifyExitCode: "number.integer",
  overBudget: "boolean",
  "error?": "string",
});
export type TaskResult = typeof TaskResult.infer;

export const CompletionTotals = type({
  tasksTotal: "number.integer >= 0",
  runsTotal: "number.integer >= 0",
  completedRuns: "number.integer >= 0",
  completionRate: "0<=number<=1",
  meanTurnsToCompletion: "number >= 0",
  meanAgentDurationMs: "number >= 0",
  meanVerifyDurationMs: "number >= 0",
  totalFailedToolCalls: "number.integer >= 0",
  totalCompactionEvents: "number.integer >= 0",
  totalDoomLoopInterventions: "number.integer >= 0",
  totalThrashInterventions: "number.integer >= 0",
  totalGateSuspensions: "number.integer >= 0",
});
export type CompletionTotals = typeof CompletionTotals.infer;

export const CompletionReport = type({
  harness: "string",
  version: "number.integer >= 1",
  startedAt: "string",
  finishedAt: "string",
  commitSha: "string",
  provider: "string",
  model: "string",
  repeats: "number.integer >= 1",
  taskSetVersion: "number.integer >= 1",
  taskIds: "string[]",
  results: TaskResult.array(),
  totals: CompletionTotals,
});
export type CompletionReport = typeof CompletionReport.infer;

// Report schema revision: bump when field names or totals change so a v1
// baseline file can never be mistaken for a current-schema report.
export const REPORT_VERSION = 2;

/** Parse and validate an unknown task-set payload (e.g. tasks.json). */
export function parseTaskSetFile(payload: unknown): CompletionTaskSet {
  return CompletionTaskSet.assert(payload);
}

/** Parse and validate an unknown responder-script payload. */
export function parseResponderScript(payload: unknown): ResponderScript {
  return ResponderScript.assert(payload);
}

/**
 * Resolve a task-set fixture/script/verify reference against the harness
 * task directory. Custom task sets are untrusted: absolute paths and `..`
 * escapes outside the directory are rejected so fixture copies and grader
 * spawns cannot reach outside evals/completion/.
 */
export function resolveTaskRelativePath(taskDir: string, ref: string): string {
  if (ref.trim() === "" || isAbsolute(ref)) {
    throw new Error(`Task path escapes the harness directory: ${ref}`);
  }
  const resolved = resolve(taskDir, ref);
  const rel = relative(taskDir, resolved);
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`Task path escapes the harness directory: ${ref}`);
  }
  return resolved;
}

/** Assert every task-set path reference stays inside the harness directory. */
export function assertTaskSetContained(
  taskSet: CompletionTaskSet,
  taskDir: string,
): void {
  for (const task of taskSet.tasks) {
    resolveTaskRelativePath(taskDir, task.fixture);
    resolveTaskRelativePath(taskDir, task.script);
    resolveTaskRelativePath(taskDir, task.verify);
  }
}

/**
 * Completion predicate shared by the runner and tests: a run counts as
 * complete only when the agent loop finished cleanly, the grader passed,
 * and the run stayed within its turn budget.
 */
export const isCompletedRun = (
  result: Pick<TaskResult, "runStatus" | "verifyExitCode" | "overBudget">,
): boolean =>
  result.runStatus === "completed" &&
  result.verifyExitCode === 0 &&
  result.overBudget === false;

/** Aggregate per-run results into report totals. */
export function computeTotals(
  results: readonly TaskResult[],
): CompletionTotals {
  const completed = results.filter((result) => result.completed);
  const completedTurns = completed.map((result) => result.turnsUsed);
  const sum = (values: readonly number[]): number =>
    values.reduce((acc, value) => acc + value, 0);
  return {
    tasksTotal: new Set(results.map((result) => result.taskId)).size,
    runsTotal: results.length,
    completedRuns: completed.length,
    completionRate:
      results.length === 0 ? 0 : completed.length / results.length,
    meanTurnsToCompletion:
      completedTurns.length === 0
        ? 0
        : sum(completedTurns) / completedTurns.length,
    meanAgentDurationMs:
      results.length === 0
        ? 0
        : sum(results.map((result) => result.agentDurationMs)) / results.length,
    meanVerifyDurationMs:
      results.length === 0
        ? 0
        : sum(results.map((result) => result.verifyDurationMs)) /
          results.length,
    totalFailedToolCalls: sum(results.map((result) => result.failedToolCalls)),
    totalCompactionEvents: sum(
      results.map((result) => result.compactionEvents),
    ),
    totalDoomLoopInterventions: sum(
      results.map((result) => result.doomLoopInterventions),
    ),
    totalThrashInterventions: sum(
      results.map((result) => result.thrashInterventions),
    ),
    totalGateSuspensions: sum(results.map((result) => result.gateSuspensions)),
  };
}

const formatRate = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

/** Human-readable summary: console output and the recorded baseline companion. */
export function formatSummary(report: CompletionReport): string {
  const lines = [
    `Completion baseline (${report.harness} v${report.version})`,
    `commit ${report.commitSha} provider ${report.provider} model ${report.model}`,
    `window ${report.startedAt} .. ${report.finishedAt} repeats ${report.repeats}`,
    `task set v${report.taskSetVersion}: ${report.taskIds.join(", ")}`,
    `completion rate ${formatRate(report.totals.completionRate)} (${report.totals.completedRuns}/${report.totals.runsTotal} runs)`,
    `mean turns to completion ${report.totals.meanTurnsToCompletion.toFixed(1)} mean agent time ${Math.round(report.totals.meanAgentDurationMs)}ms mean verify time ${Math.round(report.totals.meanVerifyDurationMs)}ms`,
    `failed tool calls ${report.totals.totalFailedToolCalls} compaction events ${report.totals.totalCompactionEvents} doom-loop interventions ${report.totals.totalDoomLoopInterventions} thrash interventions ${report.totals.totalThrashInterventions} gate suspensions ${report.totals.totalGateSuspensions}`,
    "",
    ...report.results.map(
      (result) =>
        `- ${result.taskId} r${result.repeat}: ${result.completed ? "complete" : "incomplete"} ` +
        `(status ${result.runStatus}, turns ${result.turnsUsed}${result.turnsEstimated === true ? " (estimated)" : ""}, tools ${result.toolCallCount}, ` +
        `failed tool calls ${result.failedToolCalls}, doom-loop ${result.doomLoopInterventions}, ` +
        `verify exit ${result.verifyExitCode}, agent ${result.agentDurationMs}ms verify ${result.verifyDurationMs}ms)`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

// Frozen v1 report shapes (baseline-2026-09-14.json): v1 stored failed
// tool calls twice — as failedToolCalls and, mislabeled, as retryCount —
// and never aggregated verify durations into totals. These readers exist
// only so the frozen baseline stays byte-identical while remaining
// machine-checkable; new reports must use the v2 shapes above.
const LegacyTaskResult = type({
  taskId: "string",
  title: "string",
  profile: ResponderProfile,
  repeat: "number.integer >= 0",
  completed: "boolean",
  runStatus: RunStatus,
  turnsUsed: "number.integer >= 0",
  toolCallCount: "number.integer >= 0",
  failedToolCalls: "number.integer >= 0",
  retryCount: "number.integer >= 0",
  compactionEvents: "number.integer >= 0",
  doomLoopInterventions: "number.integer >= 0",
  thrashInterventions: "number.integer >= 0",
  gateSuspensions: "number.integer >= 0",
  agentDurationMs: "number.integer >= 0",
  verifyDurationMs: "number.integer >= 0",
  verifyExitCode: "number.integer",
  overBudget: "boolean",
  "error?": "string",
});

const LegacyCompletionReport = type({
  harness: "string",
  version: "number.integer >= 1",
  startedAt: "string",
  finishedAt: "string",
  commitSha: "string",
  provider: "string",
  model: "string",
  repeats: "number.integer >= 1",
  taskSetVersion: "number.integer >= 1",
  taskIds: "string[]",
  results: LegacyTaskResult.array(),
});

/**
 * Migrate a frozen v1 report to the current schema without guessing: the
 * mislabeled retryCount is dropped only after proving it equals
 * failedToolCalls (a mismatch means hand-edited data and is rejected),
 * verify means are recomputed from the recorded per-run durations, and
 * turnsEstimated stays unset because v1 never tracked turns provenance.
 */
export function migrateLegacyCompletionReport(
  payload: unknown,
): CompletionReport {
  const legacy = LegacyCompletionReport.assert(payload);
  if (legacy.version !== 1) {
    throw new Error(
      `Only v1 reports can be migrated, got version ${legacy.version}`,
    );
  }
  const results = legacy.results.map((legacyResult) => {
    if (legacyResult.retryCount !== legacyResult.failedToolCalls) {
      throw new Error(
        `Legacy result for ${legacyResult.taskId} r${legacyResult.repeat} ` +
          `mislabels retries: retryCount ${legacyResult.retryCount} !== ` +
          `failedToolCalls ${legacyResult.failedToolCalls}`,
      );
    }
    return {
      taskId: legacyResult.taskId,
      title: legacyResult.title,
      profile: legacyResult.profile,
      repeat: legacyResult.repeat,
      completed: legacyResult.completed,
      runStatus: legacyResult.runStatus,
      turnsUsed: legacyResult.turnsUsed,
      toolCallCount: legacyResult.toolCallCount,
      failedToolCalls: legacyResult.failedToolCalls,
      compactionEvents: legacyResult.compactionEvents,
      doomLoopInterventions: legacyResult.doomLoopInterventions,
      thrashInterventions: legacyResult.thrashInterventions,
      gateSuspensions: legacyResult.gateSuspensions,
      agentDurationMs: legacyResult.agentDurationMs,
      verifyDurationMs: legacyResult.verifyDurationMs,
      verifyExitCode: legacyResult.verifyExitCode,
      overBudget: legacyResult.overBudget,
      ...(legacyResult.error !== undefined
        ? { error: legacyResult.error }
        : {}),
    };
  });
  return CompletionReport.assert({
    harness: legacy.harness,
    version: REPORT_VERSION,
    startedAt: legacy.startedAt,
    finishedAt: legacy.finishedAt,
    commitSha: legacy.commitSha,
    provider: legacy.provider,
    model: legacy.model,
    repeats: legacy.repeats,
    taskSetVersion: legacy.taskSetVersion,
    taskIds: legacy.taskIds,
    results,
    totals: computeTotals(TaskResult.array().assert(results)),
  });
}
