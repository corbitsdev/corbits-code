import type { ApprovalOutcome, PermissionRequest } from "../permission/types.js";
import type { OperatorResult } from "../agent/tools.js";

export type OperatorGateEvent = {
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
};

export type PermissionGateEvent = {
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
};
