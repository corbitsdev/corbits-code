/**
 * Fleet authority: the runtime boundary between the three tiers.
 *
 * Tier enforcement lives here and at the tool-mount point in run.ts — never
 * in a prompt. This module owns two checks:
 *
 *  - assertTierMayMountFleetVerb: a Tier 3 leaf may never mount a fleet verb
 *    (spawn_agent, wait_agents, list_agents, interrupt_agent, close_agent,
 *    resume_agent, send_input, read_agent_trace, search_agents).
 *    Fleet *discovery* of the director catalog (search_agents) is Tier 1 only
 *    (CL-7051). list_agents is not catalog discovery — it lists this install's
 *    own spawn_agent workers, the same scoped mailbox wait_agents uses, so
 *    nested orchestrators may mount it.
 *  - assertCanTargetAgent: a Tier 2 nested orchestrator may act only on its
 *    own descendants, never a sibling or anything above it in the tree.
 *    Tier 1 (the primary orchestrator) may target anyone. Callers pass the
 *    live fleet as a flat list of {id, parentSessionId} nodes — the same
 *    shape SubAgentSessionStore already tracks — so no parallel tree
 *    structure is needed.
 */

import type { SubagentTier } from "../agent/directors/types.js";

export type { SubagentTier } from "../agent/directors/types.js";

/**
 * Every tool that grants control over other agents (spawn, list, steer,
 * observe). Tier 3 leaves may mount none of these — ever.
 */
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

/**
 * Fleet discovery — Tier 1 (skywalker) only. Nested orchestrators spawn from
 * a closed allowlist and must not index the full fleet (CL-7051).
 */
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
 * Guard at the tool-mount point: throws if the caller's tier may not receive
 * this fleet verb. Call this where tools are assembled (run.ts), not from a
 * prompt instruction — a leaf must never even hold the tool; a nested
 * orchestrator must never hold fleet-discovery verbs.
 */
export function assertTierMayMountFleetVerb(tier: SubagentTier, toolName: string): void {
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
        `Only Tier 1 (skywalker) may discover the fleet; nested directors spawn from their allowlist.`,
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
 * Authority rule (root owns its tree; a child manages only its own
 * descendants): throws unless `actor` is Tier 1, or `targetId` is `actor.id`
 * itself, or a descendant of `actor.id` in `nodes`. A Tier 3 leaf holds no
 * fleet verbs at all and can never reach this check with a real call, so it
 * always fails closed here too.
 *
 * Production call sites: `read_agent_trace`, `wait_agents` explicit targets,
 * `send_input`, `interrupt_agent`, `close_agent`, and `resume_agent` (nested mounts pass
 * authority from run.ts; Tier-1 primary omits it and stays unrestricted).
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
