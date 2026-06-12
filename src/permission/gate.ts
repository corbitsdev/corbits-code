import type { ToolCall } from "@intx/types/runtime";
import type { Approval, RequestApproval } from "./types.js";
import { classifyTool, buildRequests, isAutoAllowedShellCall } from "./classify.js";
import { isApproved } from "./matcher.js";

export type GateVerdict = { allowed: true } | { allowed: false; reason: string };

export type PermissionGateOptions = {
  // Approvals already remembered for this directory. Used only to SEED the gate;
  // the gate copies them and owns its in-memory list, so the caller's array is
  // never mutated and two gates never cross-contaminate through a shared array.
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
  // Auto-approve non-destructive permissions (repeat writes, safe shell commands).
  auto?: boolean;
};

export type PermissionGate = {
  evaluate: (call: ToolCall) => Promise<GateVerdict>;
  // The gate's current in-memory approvals, including any granted this session.
  getApprovals: () => readonly Approval[];
  // Forget every remembered approval so a fresh session re-prompts from scratch.
  reset: () => void;
};

export function createPermissionGate(options: PermissionGateOptions): PermissionGate {
  const { requestApproval, persist, interactive, skipPermissions, auto } = options;
  // Own a private copy so evaluating a grant never mutates the caller's array.
  const approvals: Approval[] = [...options.approvals];

  const evaluate = async (call: ToolCall): Promise<GateVerdict> => {
    if (skipPermissions) return { allowed: true };
    if (classifyTool(call.name) === "allow") return { allowed: true };
    if (isAutoAllowedShellCall(call)) return { allowed: true };
    if (auto && call.name !== "run_shell") return { allowed: true };

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

  const reset = (): void => {
    approvals.length = 0;
  };

  return { evaluate, getApprovals: () => approvals, reset };
}
