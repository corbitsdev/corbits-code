import type { DirectorPackage } from "./types.js";
import type { ModelRole } from "./types.js";
import type { ReasoningEffort } from "../../provider/reasoning-effort.js";
import { formatBakedOptionalSkills } from "./bake-skills.js";

/**
 * Prefix every director system prompt with a stable identity block so the model
 * always sees agent id, model role, and optional skills — no ambiguity about which
 * package it is or how the parent should re-spawn it.
 *
 * Workers (non-orchestrator): bake first-party optionalSkills bodies (CL-6803)
 * and only advertise that bake when at least one body resolved. Primary
 * orchestrator (skywalker): use_skill is mounted — list skill names only; do
 * not bake huge dispatch/interview bodies or claim use_skill is unmounted.
 */
export function formatDirectorSystemPrompt(pkg: DirectorPackage): string {
  const names = pkg.optionalSkills;
  const isPrimaryOrchestrator = pkg.tier === "orchestrator";

  let skillsLine: string | null = null;
  let baked = "";

  if (names === undefined) {
    skillsLine = null;
  } else if (names.length === 0) {
    skillsLine = "Optional skills: none by default.";
  } else if (isPrimaryOrchestrator) {
    skillsLine = `Optional skills (names for awareness; use_skill is primary-mounted): ${names.join(", ")}.`;
  } else {
    baked = formatBakedOptionalSkills(names);
    skillsLine =
      baked.length > 0
        ? `Optional skills (names for awareness; guidance is baked into this prompt — use_skill is not mounted on workers): ${names.join(", ")}.`
        : `Optional skills (names for awareness — use_skill is not mounted on workers): ${names.join(", ")}.`;
  }

  const header = [
    `Identity: agent id \`${pkg.id}\` — spawn as task(agent="${pkg.id}").`,
    `Model role: ${pkg.modelRole}.`,
    ...(skillsLine !== null ? [skillsLine] : []),
  ].join("\n");
  return `${header}\n\n${pkg.systemPrompt}${baked}`;
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

export function defaultEffortForDirector(pkg: DirectorPackage): ReasoningEffort {
  if (pkg.id === "intern") return "low";
  return MODEL_ROLE_DEFAULT_EFFORT[pkg.modelRole];
}
