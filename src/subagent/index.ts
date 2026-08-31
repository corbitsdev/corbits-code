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
  liveFleetCount,
  observeFleet,
  type FleetLane,
  type FleetObservation,
  type FleetWatch,
} from "./fleet-report.js";
export {
  EMPTY_THRASH_STATE,
  nextThrashState,
  salvagePathsFromThrash,
  type ThrashState,
} from "./thrash.js";
export {
  appendActivitySummary,
  buildDispatchBrief,
  demoteNestedReportHeadings,
  formatSubAgentReport,
  hasReportEnvelope,
  parseSubAgentReport,
  subAgentToolName,
  type DispatchBrief,
  type SubAgentReport,
  type TaskIntent,
} from "./report.js";
export {
  SUBAGENT_DEADLINE_MARGIN_MS,
  MAX_TOOLLESS_NARRATION_CYCLES,
  appendSubAgentParentHints,
  evaluateSubAgentStop,
  evaluateToolLessNarrationSpiral,
  forcedStopReport,
  partialTextFromEvent,
  preferCompletedSubAgentReply,
  resolveSubAgentCatchOutcome,
  resolveSubAgentDeadlineMs,
  type ForcedStopReason,
  type ForcedStopReportOptions,
  type SubAgentCatchOutcome,
  type SubAgentParentHintOptions,
  type SubAgentStopReason,
  type ToolLessNarrationSpiral,
} from "./stop-policy.js";

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
  RunSubAgentResult,
  SubAgentProvider,
  SubAgentSandboxDeps,
  SubAgentTelemetryRollup,
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
  cleanupSubAgentWorktree,
  createSubAgentWorktree,
  WorktreeError,
  type SubAgentWorktree,
  type WorktreeCleanupResult,
  type WorktreeExec,
} from "./worktree.js";
