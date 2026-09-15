/**
 * Sub-agent public API barrel.
 *
 * Implementation lives in focused modules; this file re-exports for stable
 * import paths (`../subagent/index.js`, `./subagent.js`, etc.).
 */

export type { SubAgentSessionStore } from "./session-store.js";
export { createSubAgentSessionStore } from "./session-store.js";
export {
  createFleetWatch,
  fleetDigest,
  FLEET_REPORT_SETTLE_MS,
  FLEET_STALL_POLL_MS,
  liveFleetCount,
  observeFleet,
  pendingAskSnapshot,
} from "./fleet-report.js";
export { driveOpenTasksAfterFleetDry } from "./fleet-dry-drive.js";
export {
  driveMailboxMail,
  latchMailboxMailDrive,
} from "./mailbox-mail-drive.js";
export {
  EMPTY_THRASH_STATE,
  nextThrashState,
  salvagePathsFromThrash,
} from "./thrash.js";
export {
  buildDispatchBrief,
  formatSubAgentReport,
  formatTurnTokenNotice,
  hasPlanFindings,
  hasReportEnvelope,
  parseSubAgentReport,
  subAgentToolName,
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
} from "./stop-policy.js";

export { SubAgentDirector } from "./nudge-director.js";

export {
  SUBAGENT_PLUGIN_SPAWN_TEARDOWN_LIMITS,
  createSubAgentSpawnRegistryPlugin,
  disposeSubAgentSession,
} from "./dispose.js";

export type { SubAgentProvider } from "./types.js";

export {
  createSubAgentRunController,
  runSubAgent,
  shouldRequireEvidence,
  shouldRequirePlanSubstance,
} from "./run.js";
