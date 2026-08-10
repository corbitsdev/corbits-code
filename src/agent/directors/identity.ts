import type { DirectorPackage } from "./types.js";
import type { ModelRole } from "./types.js";
import type { ReasoningEffort } from "../../provider/reasoning-effort.js";

/**
 * Prefix every director system prompt with a stable identity block so the model
 * always sees agent id, model role, and optional skills — no ambiguity about which
 * package it is or how the parent should re-spawn it.
 */
export function formatDirectorSystemPrompt(pkg: DirectorPackage): string {
  const skillsLine =
    pkg.optionalSkills === undefined
      ? null
      : pkg.optionalSkills.length === 0
        ? "Optional skills: none by default."
        : `Optional skills (names for awareness; guidance is baked into this prompt — use_skill is not mounted on leaves): ${pkg.optionalSkills.join(", ")}.`;
  const header = [
    `Identity: agent id \`${pkg.id}\` — spawn as task(agent="${pkg.id}").`,
    `Model role: ${pkg.modelRole}.`,
    ...(skillsLine !== null ? [skillsLine] : []),
  ].join("\n");
  return `${header}\n\n${pkg.systemPrompt}`;
}

/**
 * Product default reasoning effort by package modelRole (CL-5816 slice).
 * Intern is the cheap leaf: same implement role, lower effort budget.
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

export function defaultEffortForDirector(pkg: DirectorPackage): ReasoningEffort {
  if (pkg.id === "intern") return "low";
  return MODEL_ROLE_DEFAULT_EFFORT[pkg.modelRole];
}
