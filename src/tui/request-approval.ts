import { getLogger } from "@intx/log";
import { LOG_NAMESPACE_ROOT } from "../branding.js";
import type { ApprovalOutcome, PermissionRequest, RequestApproval } from "../permission/types.js";
import { getToolApprovalBudget } from "./tool-execution-watchdog.js";
import type { PermissionGateEvent } from "./gate-events.js";

export type CreateGateRequestApprovalArgs = {
  /** Emits the gate event to the UI; returns false when nothing is listening. */
  emitGate: (event: PermissionGateEvent) => boolean;
  /**
   * Auto-deny timeout parameters for an unattended run, or undefined when
   * nothing currently arms it. No caller supplies a non-undefined value today
   * — the goal subsystem was the only arming condition and has been removed;
   * a future generalized auto-continue mechanism owns re-arming this.
   */
  approvalTimeout: () => { timeoutMs: number; timeoutMessage: string } | undefined;
};

const logger = getLogger([LOG_NAMESPACE_ROOT, "tui", "permission"]);

/**
 * Wires a gate's settle callback to the ALS tool-approval budget, so every
 * gate (permission, ask_operator, MCP TOFU) freezes the tool's wall-clock
 * budget the same way while a human decides. The budget is paused the moment
 * the gate is raised, not deferred until its overlay is actually shown: it
 * guards the tool's own execution timeout, which keeps running for any tool
 * call regardless of whether an approval overlay is on screen, so deferring
 * the pause would let a queued-and-invisible request burn its tool timeout
 * with no protection at all — a worse failure than the one being fixed.
 * `resolve` is called at most once no matter how many times the returned
 * `finish` is invoked. The budget handle is captured at gate time: `finish`
 * may run on the UI thread outside the tool ALS, so an ALS re-lookup there
 * would no-op on resume.
 */
export function attachApprovalBudget<T>(
  resolve: (value: T) => void,
  logContext: { tool: string; kind: string },
): { finish: (value: T) => void; signal?: AbortSignal } {
  const budget = getToolApprovalBudget();
  if (budget === undefined) {
    // Every TUI tool call runs under the watchdog ALS; an absent store means
    // the gate fired outside a tool run or the ALS context was lost.
    logger.warn("{kind} gate reached with no tool budget in ALS for {tool}", logContext);
  }
  const pauseToken = budget?.waitForApproval ? budget.pause() : undefined;
  let settled = false;
  const finish = (value: T): void => {
    if (settled) return;
    settled = true;
    if (pauseToken !== undefined) budget?.resume(pauseToken);
    resolve(value);
  };
  return {
    finish,
    ...(budget !== undefined ? { signal: budget.signal } : {}),
  };
}

/**
 * Builds the permission gate's requestApproval callback for the TUI.
 *
 * Always attaches the budget signal so a timeout with waitForApproval off
 * dismisses the modal instead of leaving a ghost.
 */
export function createGateRequestApproval(args: CreateGateRequestApprovalArgs): RequestApproval {
  return (request: PermissionRequest) =>
    new Promise<ApprovalOutcome>((resolve) => {
      const { finish, signal } = attachApprovalBudget<ApprovalOutcome>(resolve, {
        tool: request.tool,
        kind: "permission",
      });
      const timeout = args.approvalTimeout();
      const event: PermissionGateEvent = {
        request,
        resolve: finish,
        ...(timeout !== undefined ? timeout : {}),
        ...(signal !== undefined ? { signal } : {}),
      };
      if (!args.emitGate(event)) {
        // Pre-mount or post-unmount: no gate queue exists, so the prompt would
        // never render and finish() would never run. Fail closed.
        logger.warn("permission gate emitted with no listener for {tool}; denying", {
          tool: request.tool,
        });
        finish({ allow: false, message: "no approval UI available; request denied" });
      }
    });
}
