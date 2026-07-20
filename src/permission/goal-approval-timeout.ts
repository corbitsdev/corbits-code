import type { GoalStatus } from "../agent/goal.js";

// While a goal is actively running, pending operator approvals must not park the
// session overnight. After this timeout the request is denied with a note the
// agent can act on, and the goal continue-rule can keep going.
export const DEFAULT_GOAL_APPROVAL_TIMEOUT_MS = 15_000;

/** Only an actively running goal arms the approval timeout (not paused/budget-stopped). */
export function isGoalApprovalTimeoutActive(status: GoalStatus | null | undefined): boolean {
  return status === "active";
}

export function goalApprovalTimeoutMessage(timeoutMs: number = DEFAULT_GOAL_APPROVAL_TIMEOUT_MS): string {
  const secs = Math.max(1, Math.round(timeoutMs / 1000));
  return (
    `Goal mode: operator did not respond within ${secs}s (human may be away). ` +
    `Request skipped — do not retry the same gated action; continue the goal another way or finish without it.`
  );
}
