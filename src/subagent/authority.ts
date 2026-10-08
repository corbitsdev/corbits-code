/**
 * Fleet authority: which tier may mount fleet verbs and target which agents.
 * Enforced here and at the tool-mount point in run.ts, never in a prompt.
 *
 * assertTierMayMountFleetVerb: Tier 3 leaves never mount fleet verbs; fleet
 * discovery (search_agents) is Tier 1 only. list_agents lists this install's
 * own workers, not the catalog, so nested orchestrators may mount it.
 * assertCanTargetAgent: Tier 2 nested orchestrators act only on their own
 * descendants, never a sibling or ancestor; Tier 1 may target anyone.
 * Callers pass the live fleet as a flat {id, parentSessionId} list, the same
 * shape SubAgentSessionStore tracks, so no parallel tree is needed.
 */

import type { SubagentTier } from "../agent/directors/types.js";

export type { SubagentTier } from "../agent/directors/types.js";

/** Every tool that grants control over other agents (spawn, list, steer,
 * observe). Tier 3 leaves mount none of these, ever. */
export const FLEET_VERBS = new Set([
  "search_agents",
  "spawn_agent",
  "wait_agents",
  "list_agents",
  "send_input",
  "interrupt_agent",
  "close_agent",
  "resume_agent",
  "read_agent_trace",
]);

/** Fleet discovery, Tier 1 only: nested orchestrators spawn from a closed
 * allowlist and must not index the full fleet. */
export const ORCHESTRATOR_ONLY_FLEET_VERBS = new Set(["search_agents"]);

export function isFleetVerb(toolName: string): boolean {
  return FLEET_VERBS.has(toolName);
}

export function isOrchestratorOnlyFleetVerb(toolName: string): boolean {
  return ORCHESTRATOR_ONLY_FLEET_VERBS.has(toolName);
}

export class FleetAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FleetAuthorityError";
  }
}

/**
 * Throw if the caller's tier may not mount this fleet verb. Called where
 * tools are assembled (run.ts), not from a prompt — a leaf never even holds
 * the tool; a nested orchestrator never holds fleet-discovery verbs.
 */
export function assertTierMayMountFleetVerb(
  tier: SubagentTier,
  toolName: string,
): void {
  if (!isFleetVerb(toolName)) return;
  if (tier === "leaf") {
    throw new FleetAuthorityError(
      `Tier 3 leaf directors cannot mount fleet verb "${toolName}". ` +
        `Leaves get ask_director / submit_result / progress_note only.`,
    );
  }
  if (tier === "nested-orchestrator" && isOrchestratorOnlyFleetVerb(toolName)) {
    throw new FleetAuthorityError(
      `Tier 2 nested orchestrators cannot mount fleet discovery verb "${toolName}". ` +
        `Only Tier 1 (dispatch) may discover the fleet; nested directors spawn from their allowlist.`,
    );
  }
}

/** Minimal shape of a live fleet member — matches SubAgentSessionStore records. */
export interface FleetNode {
  readonly id: string;
  readonly parentSessionId?: string | undefined;
}

function isDescendant(
  nodes: readonly FleetNode[],
  ancestorId: string,
  candidateId: string,
): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  let cursor = byId.get(candidateId);
  const seen = new Set<string>();
  while (cursor?.parentSessionId !== undefined && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    if (cursor.parentSessionId === ancestorId) return true;
    cursor = byId.get(cursor.parentSessionId);
  }
  return false;
}

/**
 * Throw unless `actor` is Tier 1, or `targetId` is `actor.id` itself or a
 * descendant in `nodes` (root owns its tree; a child manages only its own
 * descendants). A Tier 3 leaf holds no fleet verbs and fails closed here too.
 *
 * Production call sites: `read_agent_trace`, `wait_agents` explicit targets,
 * `send_input`, `interrupt_agent`, `close_agent`, `resume_agent` (nested
 * mounts pass authority from run.ts; Tier-1 primary omits it and stays
 * unrestricted).
 */
export function assertCanTargetAgent(
  actor: { readonly id: string; readonly tier: SubagentTier },
  targetId: string,
  nodes: readonly FleetNode[],
): void {
  if (actor.tier === "leaf") {
    throw new FleetAuthorityError(
      `Tier 3 leaf "${actor.id}" holds no fleet verbs and cannot target any agent.`,
    );
  }
  if (actor.tier === "orchestrator") return;
  if (actor.id === targetId) return;
  if (!isDescendant(nodes, actor.id, targetId)) {
    throw new FleetAuthorityError(
      `Tier 2 nested orchestrator "${actor.id}" may only target its own descendants; ` +
        `"${targetId}" is a sibling or ancestor, outside its subtree.`,
    );
  }
}
