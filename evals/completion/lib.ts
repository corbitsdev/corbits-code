/**
 * Pure helpers for the CL-7932 task-completion baseline harness.
 * No process I/O here: the runner (scripts/eval-completion.ts) owns the
 * filesystem, child processes, and the agent loop; this module owns the
 * shapes at the boundary (arktype) plus completion math and the summary.
 */

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
export type TaskResult = typeof TaskResult.infer;

export const CompletionTotals = type({
  tasksTotal: "number.integer >= 0",
  runsTotal: "number.integer >= 0",
  completedRuns: "number.integer >= 0",
  completionRate: "0<=number<=1",
  meanTurnsToCompletion: "number >= 0",
  meanAgentDurationMs: "number >= 0",
  totalRetries: "number.integer >= 0",
  totalCompactionEvents: "number.integer >= 0",
  totalDoomLoopInterventions: "number.integer >= 0",
  totalThrashInterventions: "number.integer >= 0",
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

/** Parse and validate an unknown task-set payload (e.g. tasks.json). */
export function parseTaskSetFile(payload: unknown): CompletionTaskSet {
  return CompletionTaskSet.assert(payload);
}

/** Parse and validate an unknown responder-script payload. */
export function parseResponderScript(payload: unknown): ResponderScript {
  return ResponderScript.assert(payload);
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
    totalRetries: sum(results.map((result) => result.retryCount)),
    totalCompactionEvents: sum(
      results.map((result) => result.compactionEvents),
    ),
    totalDoomLoopInterventions: sum(
      results.map((result) => result.doomLoopInterventions),
    ),
    totalThrashInterventions: sum(
      results.map((result) => result.thrashInterventions),
    ),
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
    `mean turns to completion ${report.totals.meanTurnsToCompletion.toFixed(1)} mean agent time ${Math.round(report.totals.meanAgentDurationMs)}ms`,
    `retries ${report.totals.totalRetries} compaction events ${report.totals.totalCompactionEvents} doom-loop interventions ${report.totals.totalDoomLoopInterventions} thrash interventions ${report.totals.totalThrashInterventions}`,
    "",
    ...report.results.map(
      (result) =>
        `- ${result.taskId} r${result.repeat}: ${result.completed ? "complete" : "incomplete"} ` +
        `(status ${result.runStatus}, turns ${result.turnsUsed}, tools ${result.toolCallCount}, ` +
        `retries ${result.retryCount}, doom-loop ${result.doomLoopInterventions}, ` +
        `verify exit ${result.verifyExitCode}, agent ${result.agentDurationMs}ms)`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}
