import type { ApprovalOutcome, PermissionRequest } from "../permission/types.js";
import type { OperatorResult } from "../agent/tools.js";

export type OperatorGateEvent = {
  question: string;
  options: string[];
  resolve: (result: OperatorResult) => void;
};

export type PermissionGateEvent = {
  request: PermissionRequest;
  resolve: (outcome: ApprovalOutcome) => void;
  /**
   * When set (goal mode active), auto-deny if the operator has not answered
   * within this many ms so an unattended goal cannot park on the modal forever.
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
