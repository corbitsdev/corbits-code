import { evaluateGrants, type GrantRule } from "@intx/authz";

import type { Approval } from "./types.js";
import { matchesPattern } from "./matcher.js";
import { realpathOr } from "./worktree-roots.js";

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

// The gate's own project boundary: the session root it was constructed with,
// plus every git worktree registered against that root (which, per CL-4929,
// may live outside the root entirely — a sibling directory, not a
// subdirectory). Built once per gate from its closed-over resolvedCwd and
// rootsProvider and threaded through — never accept one built anywhere else,
// or "same project" quietly stops meaning "same gate's project."
export interface GrantWorkspace {
  resolvedCwd: string;
  roots: readonly string[];
}

// A project-scoped grant (Approval.cwd set) is confined to the session that
// minted it: it may replay only for a request whose cwd is that same session
// root, or one of the root's registered worktrees. A worktree cwd never
// equals the session root by string identity (that's the bug this closes),
// so membership is resolved through `workspace` instead of a bare `===`.
//
// `grantCwd !== workspace.resolvedCwd` is the boundary: a grant stamped with
// some OTHER project's root is rejected before roots are ever consulted, so
// a request cwd that happens to coincide with a different project's worktree
// can never match. Membership within a matching project is exact equality
// against the resolved roots, never a path-prefix — a prefix check would let
// a maliciously named sibling directory (`/repo/wt-1-evil`) match a
// legitimate root (`/repo/wt-1`). `workspace.roots` already comes back
// realpath-resolved (see worktree-roots.ts); `requestCwd` is realpath'd here
// so a symlinked checkout (macOS /tmp vs /private/tmp) still compares equal.
export function cwdMatchesGrant(
  grantCwd: string | undefined,
  requestCwd: string | undefined,
  workspace: GrantWorkspace,
): boolean {
  if (grantCwd === undefined) return true;
  if (requestCwd === undefined) return false;
  if (grantCwd !== workspace.resolvedCwd) return false;
  if (grantCwd === requestCwd) return true;
  return workspace.roots.includes(realpathOr(requestCwd));
}

// The single place that decides whether a grant's tool/providerModel/cwd
// scope covers a request, independent of whether the grant's pattern matches
// the request's subject. Every live call site that needs to know "does this
// grant cover this request's scope" — evaluateApprovals, isRequestCoveredByGrant —
// delegates here so a scoping-dimension change never has to be made in more
// than one place.
export function grantScopeMatches(
  approval: Approval,
  tool: string,
  activeProviderModel: string | undefined,
  requestCwd: string | undefined,
  workspace: GrantWorkspace,
): boolean {
  return (
    approval.tool === tool &&
    (approval.providerModel === undefined || approval.providerModel === activeProviderModel) &&
    cwdMatchesGrant(approval.cwd, requestCwd, workspace)
  );
}

export interface EvaluateApprovalsInput {
  tool: string;
  subject: string;
  approvals: readonly Approval[];
  activeProviderModel?: string | undefined;
  requestCwd?: string | undefined;
  workspace: GrantWorkspace;
}

// Grant-store evaluation via @intx/authz. Filters provider-model and cwd via
// grantScopeMatches, then asks evaluateGrants for the highest-specificity
// allow among package-compatible grants. Exact-escaped grants are checked with
// matchesPattern (equality after unescape) first so a stored exact command is
// never lost.
export async function evaluateApprovals(input: EvaluateApprovalsInput): Promise<boolean> {
  const { tool, subject, approvals, activeProviderModel, requestCwd, workspace } = input;
  const scoped = approvals.filter((a) =>
    grantScopeMatches(a, tool, activeProviderModel, requestCwd, workspace),
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
