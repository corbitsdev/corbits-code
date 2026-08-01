/**
 * Sub-agent public API barrel.
 *
 * Implementation lives in focused modules; this file re-exports for stable
 * import paths (`../subagent/index.js`, `./subagent.js`, etc.).
 */

export type { SubAgentSession, SubAgentSessionStore, SubAgentTranscriptEntry } from "./session-store.js";
export { createSubAgentSessionStore } from "./session-store.js";
export {
  DEFAULT_THRASH_CONFIG,
  EMPTY_THRASH_STATE,
  evaluateThrashStop,
  nextThrashState,
  thrashForceReport,
  thrashFromReRead,
  type ThrashConfig,
  type ThrashState,
  type ThrashStopReason,
} from "./thrash.js";
export {
  appendActivitySummary,
  buildDispatchBrief,
  demoteNestedReportHeadings,
  formatSubAgentReport,
  parseSubAgentReport,
  subAgentToolName,
  type DispatchBrief,
  type SubAgentReport,
  type TaskIntent,
} from "./report.js";
export {
  DEFAULT_SUBAGENT_REPEAT_LIMIT,
  SUBAGENT_DEADLINE_MARGIN_MS,
  appendDeadlineParentHint,
  appendNeverActedParentHint,
  appendRepetitionParentHint,
  appendSubAgentParentHints,
  appendThrashParentHint,
  appendTurnBudgetParentHint,
  evaluateSubAgentStop,
  fingerprintToolCalls,
  forcedStopReport,
  isDeadlineSubAgentReport,
  isNeverActedSubAgentReport,
  isRepetitionSubAgentReport,
  isThrashSubAgentReport,
  isTurnBudgetSubAgentReport,
  nextToolCallStreak,
  partialTextFromEvent,
  preferCompletedSubAgentReply,
  resolveSubAgentCatchOutcome,
  resolveSubAgentDeadlineMs,
  subAgentNoProgress,
  subAgentTurnLimitExceeded,
  type SubAgentCatchOutcome,
  type SubAgentStopReason,
  type ToolCallStreak,
} from "./stop-policy.js";

export { DEFAULT_SUBAGENT_MAX_TURNS } from "../config/settings.js";

export { SubAgentDirector } from "./nudge-director.js";

export {
  SUBAGENT_PLUGIN_SPAWN_TEARDOWN_LIMITS,
  SUBAGENT_SPAWN_DRAIN_MS,
  createSubAgentSpawnRegistryPlugin,
  disposeSubAgentSession,
  isSubAgentCancelError,
  type SubAgentSessionDisposeInput,
  type SubAgentSpawnRegistry,
  type SubAgentSpawnSnapshot,
} from "./dispose.js";

export type {
  NestedDispatchDeps,
  RunSubAgentParams,
  SubAgentProvider,
  SubAgentSandboxDeps,
} from "./types.js";

export {
  buildSubAgentPrimarySource,
  coreSubAgentWebTools,
  createSubAgentRunController,
  runSubAgent,
  type SubAgentRunController,
} from "./run.js";

export {
  TaskToolArgs,
  createTaskTool,
  taskToolDefinition,
  type TaskToolDeps,
} from "./task-tool.js";
