/**
 * Fleet authority: the runtime boundary between the three tiers.
 *
 * Tier enforcement lives here and at the tool-mount point in run.ts — never
 * in a prompt. This module owns two checks:
 *
 *  - assertTierMayMountFleetVerb: a Tier 3 leaf may never mount a fleet verb
 *    (today: task, search_agents, read_agent_trace; the spawn_agent/
 *    wait_agents/list_agents/send_input/interrupt_agent/close_agent/
 *    resume_agent/followup_task verbs land in later child issues against
 *    this same gate).
 *  - assertCanTargetAgent: a Tier 2 nested orchestrator may act only on its
 *    own descendants, never a sibling or anything above it in the tree.
 *    Tier 1 (the primary orchestrator) may target anyone. Addressing verbs
 *    such as read_agent_trace and send_input call this at their handler
 *    boundary. Callers pass the live fleet as a flat list of {id,
 *    parentSessionId} nodes — the same shape SubAgentSessionStore already
 *    tracks — so no parallel tree structure is needed.
 */

import type { SubagentTier } from "../agent/directors/types.js";

export type { SubagentTier } from "../agent/directors/types.js";

/**
 * Every tool that grants control over other agents (spawn, list, steer,
 * observe). Tier 3 leaves may mount none of these — ever. Verbs not yet
 * implemented are listed here so their eventual mount sites inherit the gate
 * for free instead of needing a second allowlist.
 */
export const FLEET_VERBS = new Set([
  "task",
  "search_agents",
  "spawn_agent",
  "wait_agents",
  "list_agents",
  "send_input",
  "interrupt_agent",
  "close_agent",
  "resume_agent",
  "read_agent_trace",
  "followup_task",
]);

export function isFleetVerb(toolName: string): boolean {
  return FLEET_VERBS.has(toolName);
}

export class FleetAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FleetAuthorityError";
  }
}

/**
 * Guard at the tool-mount point: throws if a Tier 3 leaf is about to receive
 * a fleet verb. Call this where tools are assembled (run.ts), not from a
 * prompt instruction — a leaf must never even hold the tool.
 */
export function assertTierMayMountFleetVerb(tier: SubagentTier, toolName: string): void {
  if (tier === "leaf" && isFleetVerb(toolName)) {
    throw new FleetAuthorityError(
      `Tier 3 leaf directors cannot mount fleet verb "${toolName}". ` +
        `Leaves get ask_director / submit_result / progress_note only.`,
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
