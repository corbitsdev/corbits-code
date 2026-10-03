/**
 * Fleet authority: Dispatch vs everyone else.
 *
 * Dispatch is the only orchestrator. Specialists (workers) never mount fleet
 * verbs. Enforcement lives here and at the tool-mount point in run.ts — never
 * in a prompt.
 *
 *  - assertTierMayMountFleetVerb: only `orchestrator` (dispatch) may mount
 *    spawn_agent, wait_agents, list_agents, interrupt_agent, close_agent,
 *    resume_agent, send_input, read_agent_trace, search_agents.
 *  - assertCanTargetAgent: dispatch may target anyone. A worker holds no fleet
 *    verbs and cannot target any agent.
 */

import type { SubagentTier } from "../agent/directors/types.js";

export type { SubagentTier } from "../agent/directors/types.js";

/**
 * Every tool that grants control over other agents. Workers may mount none.
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

/** Fleet discovery — Dispatch only. */
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
 * Guard at the tool-mount point: throws if the caller may not receive this
 * fleet verb. Dispatch only. Workers never even hold the tool.
 */
export function assertTierMayMountFleetVerb(
  tier: SubagentTier,
  toolName: string,
): void {
  if (!isFleetVerb(toolName)) return;
  if (tier !== "orchestrator") {
    throw new FleetAuthorityError(
      `Workers cannot mount fleet verb "${toolName}". ` +
        `Only dispatch spawns and manages the fleet.`,
    );
  }
}

/** Minimal shape of a live fleet member — matches SubAgentSessionStore records. */
export interface FleetNode {
  readonly id: string;
  readonly parentSessionId?: string | undefined;
}

/**
 * Dispatch may target anyone. Workers hold no fleet verbs and fail closed.
 */
export function assertCanTargetAgent(
  actor: { readonly id: string; readonly tier: SubagentTier },
  _targetId: string,
  _nodes: readonly FleetNode[],
): void {
  if (actor.tier === "orchestrator") return;
  throw new FleetAuthorityError(
    `Worker "${actor.id}" holds no fleet verbs and cannot target any agent.`,
  );
}
