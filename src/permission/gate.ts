import type { ToolCall } from "@intx/types/runtime";
import type { Approval, RequestApproval } from "./types.js";
import { classifyTool, buildRequests } from "./classify.js";
import { isApproved } from "./matcher.js";

export type GateVerdict = { allowed: true } | { allowed: false; reason: string };

export type PermissionGateOptions = {
  // Approvals already remembered for this directory. Seeded from the store; the
  // gate appends to it in memory as the operator approves new scopes.
  approvals: Approval[];
  // Surface a request to the operator. Required when interactive.
  requestApproval?: RequestApproval;
  // Persist a newly granted approval (best-effort).
  persist?: (approval: Approval) => void;
  // No operator is attached (headless). An unresolved "ask" becomes a denial
  // unless skipPermissions is set.
  interactive: boolean;
  // The --dangerously-skip-permissions escape hatch: auto-allow anything the
  // authorization layer did not already deny.
  skipPermissions: boolean;
};

export type PermissionGate = { evaluate: (call: ToolCall) => Promise<GateVerdict> };

export function createPermissionGate(options: PermissionGateOptions): PermissionGate {
  const { approvals, requestApproval, persist, interactive, skipPermissions } = options;

  const evaluate = async (call: ToolCall): Promise<GateVerdict> => {
    if (skipPermissions) return { allowed: true };
    if (classifyTool(call.name) === "allow") return { allowed: true };

    for (const request of buildRequests(call)) {
      if (isApproved(request.tool, request.subject, approvals)) continue;

      if (!interactive || requestApproval === undefined) {
        return {
          allowed: false,
          reason: `${request.action} requires operator approval, which is unavailable in a non-interactive run. Re-run with --dangerously-skip-permissions to bypass, or narrow the action.`,
        };
      }

      const outcome = await requestApproval(request);
      if (!outcome.allow) {
        const suffix = outcome.message !== undefined && outcome.message.length > 0
          ? ` — ${outcome.message}`
          : "";
        return { allowed: false, reason: `Operator declined: ${request.action} (${request.subject})${suffix}` };
      }
      if (outcome.persist && outcome.persist.pattern !== null) {
        const approval: Approval = { tool: request.tool, pattern: outcome.persist.pattern };
        approvals.push(approval);
        persist?.(approval);
      }
    }
    return { allowed: true };
  };

  return { evaluate };
}
