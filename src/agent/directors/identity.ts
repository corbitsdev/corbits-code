import type { DirectorPackage } from "./types.js";
import type { ModelRole } from "./types.js";
import type { ReasoningEffort } from "../../provider/reasoning-effort.js";

/**
 * Prefix every director system prompt with a stable identity block so the model
 * always sees agent id, model role, and optional skills — no ambiguity about which
 * package it is or how the parent should re-spawn it.
 *
 * Skill bodies are never baked here. Workers list skill names only; the worker
 * contract (src/agent/worker-contract.ts) owns the skill-escalation rule, so
 * this block carries names without repeating the guidance (CL-8212).
 */
export function formatDirectorSystemPrompt(pkg: DirectorPackage): string {
  const names = pkg.optionalSkills;
  const isPrimaryOrchestrator = pkg.tier === "orchestrator";

  let skillsLine: string | null = null;

  if (names === undefined) {
    skillsLine = null;
  } else if (names.length === 0) {
    skillsLine = "Optional skills: none by default.";
  } else if (isPrimaryOrchestrator) {
    skillsLine = `Optional skills (names for awareness; use_skill is primary-mounted): ${names.join(", ")}.`;
  } else {
    skillsLine = `Optional skills (names for awareness; load brief-named skills straight through use_skill, skill_search for discovery when mounted): ${names.join(", ")}.`;
  }

  const header = [
    `Identity: agent id \`${pkg.id}\` — spawn as spawn_agent(agent="${pkg.id}").`,
    `Model role: ${pkg.modelRole}.`,
    ...(skillsLine !== null ? [skillsLine] : []),
  ].join("\n");
  return `${header}\n\n${pkg.systemPrompt}`;
}

/**
 * Product default reasoning effort by package modelRole (CL-5816 slice).
 * Intern is the cheap worker: same implement role, lower effort budget.
 */
export const MODEL_ROLE_DEFAULT_EFFORT = {
  orchestrator: "high",
  plan: "high",
  review: "high",
  implement: "medium",
  explore: "medium",
  docs: "medium",
  test: "medium",
} as const satisfies Record<ModelRole, ReasoningEffort>;

export function defaultEffortForDirector(
  pkg: DirectorPackage,
): ReasoningEffort {
  if (pkg.id === "intern") return "low";
  return MODEL_ROLE_DEFAULT_EFFORT[pkg.modelRole];
}
