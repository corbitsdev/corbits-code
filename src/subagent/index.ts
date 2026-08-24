/**
 * Sub-agent public API barrel.
 *
 * Implementation lives in focused modules; this file re-exports for stable
 * import paths (`../subagent/index.js`, `./subagent.js`, etc.).
 */

export type {
  SubAgentSession,
  SubAgentSessionStore,
  SubAgentTranscriptEntry,
} from "./session-store.js";
export { createSubAgentSessionStore } from "./session-store.js";
export {
  createFleetWatch,
  fleetDigest,
  FLEET_REPORT_SETTLE_MS,
  FLEET_STALL_POLL_MS,
  observeFleet,
  type FleetLane,
  type FleetObservation,
  type FleetWatch,
} from "./fleet-report.js";
export {
  DEFAULT_THRASH_CONFIG,
  EMPTY_THRASH_STATE,
  evaluateThrashStop,
  nextThrashState,
  thrashForceReport,
  type ThrashConfig,
  type ThrashState,
  type ThrashStopReason,
} from "./thrash.js";
export {
  appendActivitySummary,
  buildDispatchBrief,
  demoteNestedReportHeadings,
  formatSubAgentReport,
  hasReportEnvelope,
  parseSubAgentReport,
  stopReasonFromReport,
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
  appendNoProgressParentHint,
  appendSubAgentParentHints,
  appendTurnBudgetParentHint,
  evaluateSubAgentStop,
  fingerprintToolCalls,
  forcedStopReport,
  isDeadlineSubAgentReport,
  isNeverActedSubAgentReport,
  isNeverEditedSubAgentReport,
  isNoProgressSubAgentReport,
  isTurnBudgetSubAgentReport,
  nextToolCallStreak,
  partialTextFromEvent,
  preferCompletedSubAgentReply,
  resolveSubAgentCatchOutcome,
  resolveSubAgentDeadlineMs,
  subAgentNoProgress,
  subAgentTurnLimitExceeded,
  TURN_BUDGET_STOP_PARENT_HINT,
  type SubAgentCatchOutcome,
  type SubAgentParentHintOptions,
  type SubAgentStopReason,
  type ToolCallStreak,
} from "./stop-policy.js";

export {
  TURN_BUDGET_STOP_AFTER_DISPATCHES,
  classifyBriefSalvage,
  createBriefDispatchLedger,
  fingerprintTaskBrief,
  isHardBlockSalvage,
  shouldStopTurnBudgetRedispatch,
  type BriefDispatchLedger,
  type BriefDispatchRecord,
  type BriefSalvageKind,
  type HardBlockSalvage,
  type TaskBriefFingerprintInput,
} from "./brief-dispatch.js";

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
  shouldRequireEvidence,
  type SubAgentRunController,
} from "./run.js";

export {
  TaskToolArgs,
  createTaskTool,
  taskToolDefinition,
  type TaskToolDeps,
} from "./task-tool.js";

export {
  cleanupSubAgentWorktree,
  createSubAgentWorktree,
  WorktreeError,
  type SubAgentWorktree,
  type WorktreeCleanupResult,
  type WorktreeExec,
} from "./worktree.js";
