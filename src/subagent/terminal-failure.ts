import {
  isRecoverableProviderFailureCategory,
  isResolvedProviderFailureError,
} from "../inference-error-message.js";
import { errorMessage } from "../agent/error-message.js";
import { canonicalToolName } from "../agent/canonical-tool-name.js";
import { REPLAY_SAFE_TOOLS } from "../agent/tool-classification.js";
import type { ForcedStopReason } from "./stop-policy.js";

/**
 * Closed classification of how a worker run ended without a clean result.
 * Parents branch on this value; nothing downstream re-derives it from the
 * error or report prose.
 */
export type SubAgentFailureClass =
  | "provider_retryable"
  | "provider_fatal"
  | "loop_guard"
  | "stalled"
  | "deadline"
  | "incomplete_report"
  | "cancelled"
  | "interrupted"
  | "error";

export type SubAgentRecoveryReason =
  | "eligible"
  | "not_retryable"
  | "side_effects_completed"
  | "already_recovered"
  | "recovery_exhausted";

/**
 * Parent-input handoff at termination. `delivered` requires the worker's own
 * ask_director call to have returned the answer; `unknown` is never upgraded.
 */
export type SubAgentHandoffState =
  | "none"
  | "unavailable"
  | "submitted"
  | "delivered"
  | "unknown";

export type SubAgentCleanupOutcome = "released" | "partial";

export interface SubAgentRecovery {
  readonly available: boolean;
  readonly reason: SubAgentRecoveryReason;
  readonly replacement_id?: string;
}

/**
 * Written once when a run reaches a terminal non-clean outcome, before the
 * parent can observe that outcome. Snake case because it is projected to the
 * parent verbatim.
 */
export interface SubAgentFailureRecord {
  readonly agent_id: string;
  readonly failure_class: SubAgentFailureClass;
  readonly failed_at: string;
  readonly recovery: SubAgentRecovery;
  readonly attempt: number;
  readonly recovers?: string;
  readonly handoff: SubAgentHandoffState;
  readonly cleanup: SubAgentCleanupOutcome;
}

/** What the run's owner knows about a failure when it calls `fail`. */
export interface SubAgentFailureInput {
  readonly failure_class: SubAgentFailureClass;
  /** The worker's own session teardown threw or timed out. */
  readonly teardownFailed?: boolean;
}

export function isProviderFailureClass(cls: SubAgentFailureClass): boolean {
  return cls === "provider_retryable" || cls === "provider_fatal";
}

export function failureClassForStopReason(
  reason: ForcedStopReason,
): SubAgentFailureClass {
  return reason === "incomplete-report" ? "incomplete_report" : reason;
}

const loopGuardErrors = new WeakSet<Error>();

/**
 * Typed wrapper for a run the reactor's doom-loop guard stopped. The message
 * is the cause's, so operator-facing error text does not change.
 */
export function createSubAgentLoopGuardError(cause: unknown): Error {
  const error = new Error(errorMessage(cause), { cause });
  error.name = "SubAgentLoopGuardError";
  loopGuardErrors.add(error);
  return error;
}

export function isSubAgentLoopGuardError(err: unknown): boolean {
  return err instanceof Error && loopGuardErrors.has(err);
}

// assertReplySend tags a send that parked on an approval gate; that is a
// permission outcome even if an inference.error happened to precede it.
function isPermissionSuspension(err: unknown): boolean {
  return err instanceof Error && "suspendedType" in err;
}

/**
 * Classify a thrown worker run. Only typed signals count: the loop-guard
 * wrapper, a resolved provider failure, and the fleet's own observation that
 * the last inference event was an `inference.error`.
 */
export function classifySubAgentFailure(
  err: unknown,
  ctx: { providerFailureObserved?: boolean } = {},
): SubAgentFailureClass {
  if (isSubAgentLoopGuardError(err)) return "loop_guard";
  if (isResolvedProviderFailureError(err)) {
    return isRecoverableProviderFailureCategory(err.category)
      ? "provider_retryable"
      : "provider_fatal";
  }
  if (isPermissionSuspension(err)) return "error";
  if (ctx.providerFailureObserved === true) return "provider_fatal";
  return "error";
}

/** Whether a call to `name` can be replayed by a recovery attempt. */
export function isReplaySafeToolName(name: string): boolean {
  return REPLAY_SAFE_TOOLS.has(canonicalToolName(name));
}

/**
 * Recovery availability for a freshly written record. The chain cap wins
 * over class: a recovery attempt that fails is exhausted whatever its cause.
 * Replay safety fails closed: any tool outside the read-only allowlist means
 * a replacement could repeat a side effect.
 */
export function recoveryFor(input: {
  failureClass: SubAgentFailureClass;
  attempt: number;
  followupTurn: boolean;
  replaySafe: boolean;
}): SubAgentRecovery {
  if (input.attempt > 1) {
    return { available: false, reason: "recovery_exhausted" };
  }
  if (input.followupTurn || input.failureClass !== "provider_retryable") {
    return { available: false, reason: "not_retryable" };
  }
  if (!input.replaySafe) {
    return { available: false, reason: "side_effects_completed" };
  }
  return { available: true, reason: "eligible" };
}
