import { evaluateGrants, type GrantRule } from "@intx/authz";

import type { Approval } from "./types.js";
import { matchesPattern } from "./matcher.js";

// Exact-escaped patterns (backslash before metacharacters) cannot round-trip
// through @intx/authz matchPattern, so those grants are filtered out of the
// package call and handled by the exact-equality path in matcher.ts.
function isPackageCompatiblePattern(pattern: string): boolean {
  return !pattern.includes("\\");
}

export function approvalToGrantRule(approval: Approval, index: number): GrantRule {
  return {
    id: `corbits-approval-${index}`,
    principalId: null,
    roleId: null,
    effect: "allow",
    origin: "invoker",
    // resource = subject pattern (command or path); action = tool name.
    resource: approval.pattern,
    action: approval.tool,
    conditions: null,
    expiresAt: null,
  };
}

export type EvaluateApprovalsInput = {
  tool: string;
  subject: string;
  approvals: readonly Approval[];
  activeProviderModel?: string | undefined;
  requestCwd?: string | undefined;
};

// Grant-store evaluation via @intx/authz. Filters provider-model and cwd the
// same way isApproved does, then asks evaluateGrants for the highest-specificity
// allow among package-compatible grants. Exact-escaped grants are checked with
// matchesPattern (equality after unescape) first so a stored exact command is
// never lost.
export async function evaluateApprovals(input: EvaluateApprovalsInput): Promise<boolean> {
  const { tool, subject, approvals, activeProviderModel, requestCwd } = input;
  const scoped = approvals.filter(
    (a) =>
      a.tool === tool &&
      (a.providerModel === undefined || a.providerModel === activeProviderModel) &&
      (a.cwd === undefined || a.cwd === requestCwd),
  );
  if (scoped.length === 0) return false;

  for (const a of scoped) {
    if (!isPackageCompatiblePattern(a.pattern) && matchesPattern(subject, a.pattern)) {
      return true;
    }
  }

  const grants = scoped
    .filter((a) => isPackageCompatiblePattern(a.pattern))
    .map((a, i) => approvalToGrantRule(a, i));
  if (grants.length === 0) return false;

  const decision = await evaluateGrants(grants, subject, tool);
  return decision.effect === "allow";
}
