import { getLogger } from "@intx/log";
import { LOG_NAMESPACE_ROOT } from "../branding.js";
import type { ApprovalOutcome, PermissionRequest, RequestApproval } from "../permission/types.js";
import type { ChainedPauseToken } from "./tool-execution-watchdog.js";
import { getToolApprovalBudget } from "./tool-execution-watchdog.js";
import type { PermissionGateEvent } from "./gate-events.js";

export type CreateGateRequestApprovalArgs = {
  /** Emits the gate event to the UI; returns false when nothing is listening. */
  emitGate: (event: PermissionGateEvent) => boolean;
  /** Goal-mode auto-deny parameters, or undefined when no goal is active. */
  goalTimeout: () => { timeoutMs: number; timeoutMessage: string } | undefined;
};

const logger = getLogger([LOG_NAMESPACE_ROOT, "tui", "permission"]);

/**
 * Builds the permission gate's requestApproval callback for the TUI.
 *
 * Freezes the tool wall-clock budget while the operator decides (when
 * waitForApproval is on). Always attaches the budget signal so a timeout with
 * waitForApproval off dismisses the modal instead of leaving a ghost. The
 * budget handle is captured at gate time: finish() runs on the UI thread
 * outside the tool ALS, so an ALS re-lookup there would no-op on resume.
 */
export function createGateRequestApproval(args: CreateGateRequestApprovalArgs): RequestApproval {
  return (request: PermissionRequest) =>
    new Promise<ApprovalOutcome>((resolve) => {
      const budget = getToolApprovalBudget();
      if (budget === undefined) {
        // Every TUI tool call runs under the watchdog ALS; an absent store
        // means the gate fired outside a tool run or the ALS context was lost.
        logger.warn("permission gate reached with no tool budget in ALS for {tool}", {
          tool: request.tool,
        });
      }
      const pauseToken: ChainedPauseToken | undefined = budget?.waitForApproval
        ? budget.pause()
        : undefined;
      let settled = false;
      const finish = (outcome: ApprovalOutcome): void => {
        if (settled) return;
        settled = true;
        if (pauseToken !== undefined) budget?.resume(pauseToken);
        resolve(outcome);
      };
      const goal = args.goalTimeout();
      const event: PermissionGateEvent = {
        request,
        resolve: finish,
        ...(goal !== undefined ? goal : {}),
        ...(budget !== undefined ? { signal: budget.signal } : {}),
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
