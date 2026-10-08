import { evaluateGrants, type GrantRule } from "@intx/authz";

import {
  canonicalGrantTool,
  canonicalToolName,
  grantToolCovers,
} from "../agent/canonical-tool-name.js";
import type { Approval } from "./types.js";
import { directoryGrantAllows, matchesPattern } from "./matcher.js";
import { realpathOr } from "./worktree-roots.js";

// Exact-escaped patterns (backslash before metacharacters) cannot round-trip
// through @intx/authz matchPattern; they skip the package call and fall to
// the exact-equality path in matcher.ts.
function isPackageCompatiblePattern(pattern: string): boolean {
  return !pattern.includes("\\");
}

export function approvalToGrantRule(
  approval: Approval,
  index: number,
): GrantRule {
  return {
    id: `corbits-approval-${index}`,
    principalId: null,
    roleId: null,
    effect: "allow",
    origin: "invoker",
    // resource = subject pattern; action = tool name.
    resource: approval.pattern,
    action: canonicalToolName(approval.tool),
    conditions: null,
    expiresAt: null,
  };
}

// The gate's project boundary: the session root plus every registered git
// worktree (which may be a sibling directory, not a subdirectory). Built once
// per gate from its closed-over resolvedCwd and rootsProvider and threaded
// through — never accept one built elsewhere, or "same project" stops meaning
// "same gate's project."
export interface GrantWorkspace {
  resolvedCwd: string;
  roots: readonly string[];
}

// A project-scoped grant (Approval.cwd set) replays only for the session root
// that minted it or one of its registered worktrees. A worktree cwd never
// equals the session root by string identity (the bug this closes), so
// membership goes through `workspace`, not a bare `===`.
//
// `grantCwd !== workspace.resolvedCwd` rejects a grant stamped with another
// project's root before roots are consulted, so a coinciding request cwd in a
// different project never matches. Within a matching project, membership is
// exact equality against the resolved roots, never path-prefix (a
// `/repo/wt-1-evil` sibling would match `/repo/wt-1`). `workspace.roots` comes
// back realpath-resolved (worktree-roots.ts); `requestCwd` is realpath'd here
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

// Seeded grants enter in native key space: pure renames collapse onto the
// engine id; narrow update_plan keys (no native key preserves them without
// overclaiming capability) drop fail-closed. Fresh array; the gate owns it.
export function normalizeSeededApprovals(
  seeded: readonly Approval[],
): Approval[] {
  const out: Approval[] = [];
  for (const approval of seeded) {
    const tool = canonicalGrantTool(approval.tool);
    if (tool === null) continue;
    out.push(tool === approval.tool ? approval : { ...approval, tool });
  }
  return out;
}

// Single owner for grant tool/providerModel/cwd scope coverage, independent
// of pattern matching. Both live call sites (evaluateApprovals,
// isRequestCoveredByGrant) delegate here so a scoping-dimension change lands
// in one place.
export function grantScopeMatches(
  approval: Approval,
  tool: string,
  activeProviderModel: string | undefined,
  requestCwd: string | undefined,
  workspace: GrantWorkspace,
): boolean {
  return (
    grantToolCovers(approval.tool, tool) &&
    (approval.providerModel === undefined ||
      approval.providerModel === activeProviderModel) &&
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

// Grant-evaluation owner for the live decide() path (shell per-segment checks
// and the path-arg check). The queued-reconciliation path
// (isRequestCoveredByApprovals in gate.ts) matches inline against the same
// helpers instead of calling here — keep the two in sync. Fail-closed:
// unknown tools, unknown runners, and empty grant lists all refuse.
export async function approvalCoversSubject(
  input: EvaluateApprovalsInput,
): Promise<boolean> {
  const {
    tool,
    subject,
    approvals,
    activeProviderModel,
    requestCwd,
    workspace,
  } = input;
  const action = canonicalToolName(tool);
  // Scope matching sees the raw request name: grantToolCovers is directional
  // for the update_plan/manage_tasks pair (a stored update_plan grant covers
  // only update_plan-presenting requests), so pre-canonicalizing would erase
  // the alias and wrongly deny same-alias replay. The @intx/authz call below
  // still uses the canonical action on both sides.
  const scoped = approvals.filter((a) =>
    grantScopeMatches(a, tool, activeProviderModel, requestCwd, workspace),
  );
  if (scoped.length === 0) return false;

  // Directory Always grants (`<dir>/*`) cannot reach the package evaluator with
  // a `..` walk-out subject: package `*` matches `..` lexically, so the same
  // containment gate matchesPattern enforces applies here first. Only
  // directory escapes are denied; every other grant defers untouched.
  const effectiveCwd = requestCwd ?? workspace.resolvedCwd;
  const contained = scoped.filter((a) =>
    directoryGrantAllows(a.pattern, subject, effectiveCwd),
  );
  if (contained.length === 0) return false;

  for (const a of contained) {
    if (
      !isPackageCompatiblePattern(a.pattern) &&
      matchesPattern(subject, a.pattern)
    ) {
      return true;
    }
  }

  const grants = contained
    .filter((a) => isPackageCompatiblePattern(a.pattern))
    .map((a, i) => approvalToGrantRule(a, i));
  if (grants.length === 0) return false;

  const decision = await evaluateGrants(grants, subject, action);
  return decision.effect === "allow";
}

// Grant-store evaluation entry point; delegates to approvalCoversSubject.
export async function evaluateApprovals(
  input: EvaluateApprovalsInput,
): Promise<boolean> {
  return approvalCoversSubject(input);
}
