import type { DirectorPackage } from "./types.js";
import type { ModelRole } from "./types.js";
import type { ReasoningEffort } from "../../provider/reasoning-effort.js";

/**
 * Prefix every director system prompt with a stable identity block so the model
 * always sees agent id, model role, and optional skills — no ambiguity about which
 * package it is or how the parent should re-spawn it.
 *
 * Skill bodies are never baked here. Workers (non-orchestrator) list skill
 * names only and load bodies on demand with skill_search + use_skill, scoped
 * to the dispatch's optionalSkills. Primary orchestrator (skywalker):
 * use_skill is mounted — list skill names only.
 */
/**
 * Worker skill-use rule: skills mount on every worker (scoped to the
 * dispatch's optionalSkills), so the worker searches only when the brief
 * names a skill or the task leaves its lane.
 */
export const WORKER_SKILL_SCOPING =
  "Skills are available; search only when the brief names a skill or the task is outside your lane. For a small, bounded edit, do not search skills.";

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

  // Worker skill scoping (CL-7668): skills mount on every worker, so search
  // only when the brief or the lane calls for it — never bulk-load.
  // Deny-safe: grok/kimi leaves omit skill_search (family policy) and load
  // brief-named skills straight through use_skill, so the guidance never
  // mandates a skill_search call — it is discovery-only, when mounted.
  const skillGuidance =
    names !== undefined && names.length > 0 && !isPrimaryOrchestrator
      ? `${WORKER_SKILL_SCOPING} Load a brief-named skill straight through use_skill with its exact name; call skill_search for descriptions only when choosing among skills and it is mounted, then use_skill; load only the skills the task needs.`
      : null;

  const header = [
    `Identity: agent id \`${pkg.id}\` — spawn as spawn_agent(agent="${pkg.id}").`,
    `Model role: ${pkg.modelRole}.`,
    ...(skillsLine !== null ? [skillsLine] : []),
  ].join("\n");
  return skillGuidance === null
    ? `${header}\n\n${pkg.systemPrompt}`
    : `${header}\n\n${skillGuidance}\n\n${pkg.systemPrompt}`;
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
