/**
 * Fleet authority: which tier may mount fleet verbs and target which agents.
 * Enforced here and at the tool-mount point in run.ts, never in a prompt.
 *
 * Tier 3 leaves never mount fleet verbs; fleet discovery is Tier 1 only;
 * nested orchestrators act only on their own descendants. Callers pass the
 * live fleet as a flat {id, parentSessionId} list, the shape
 * SubAgentSessionStore tracks — no parallel tree.
 */

import type { SubagentTier } from "../agent/directors/types.js";

export type { SubagentTier } from "../agent/directors/types.js";

/** Tools that grant control over other agents. Tier 3 leaves mount none. */
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

/** Fleet discovery is Tier 1 only: nested orchestrators spawn from a
 * closed allowlist. */
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
 * tools are assembled (run.ts), not from a prompt.
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
 * descendant in `nodes`. A Tier 3 leaf holds no fleet verbs and fails
 * closed here too. Tier-1 primary omits authority and stays unrestricted.
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
