import type { ApprovalOutcome, PermissionRequest } from "../permission/types.js";
import type { OperatorResult } from "../agent/tools.js";

/** Fail-closed settle when no approval UI can bind the operator's accept. */
export const APPROVAL_UNAVAILABLE_MESSAGE = "no approval UI available; request denied" as const;

export interface OperatorGateEvent {
  /** Minted by the session emitter, never by the TUI overlay. */
  id: string;
  question: string;
  options: string[];
  resolve: (result: OperatorResult) => void;
  /**
   * When set, auto-cancel if the operator has not answered within this many
   * ms so an unattended auto-continue run cannot park on the modal forever.
   */
  timeoutMs?: number;
  /** Override the agent-facing cancel message on timeout. */
  timeoutMessage?: string;
  /**
   * Tool-execution budget signal. When aborted (watchdog timeout or parent
   * cancel), this operator entry is auto-cancelled even if it is not the head
   * of the queue — so the modal cannot outlive a tool that already finished.
   */
  signal?: AbortSignal;
}

export interface PermissionGateEvent {
  /** Minted by the session emitter at gate emit, never on PermissionRequest. */
  id: string;
  request: PermissionRequest;
  resolve: (outcome: ApprovalOutcome) => void;
  /**
   * When set, auto-deny if the operator has not answered within this many ms
   * so an unattended auto-continue run cannot park on the modal forever.
   */
  timeoutMs?: number;
  /** Override the agent-facing deny message on timeout. */
  timeoutMessage?: string;
  /**
   * Tool-execution budget signal. When aborted (watchdog timeout or parent
   * cancel), this permission entry is auto-denied even if it is not the head
   * of the queue — so the modal cannot outlive a tool that already finished.
   */
  signal?: AbortSignal;
}
