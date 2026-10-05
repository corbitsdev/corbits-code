import type { DirectorPackage } from "./types.js";
import type { ModelRole } from "./types.js";
import type { ReasoningEffort } from "../../provider/reasoning-effort.js";

/**
 * Prefix every director system prompt with a stable identity block so the model
 * always sees agent id, model role, attached skills, and optional skills — no
 * ambiguity about which package it is or how the parent should re-spawn it.
 *
 * Attached skill *bodies* are injected at spawn (run.ts), not here. This block
 * carries names only. The worker contract owns the skill-escalation rule, so
 * this block does not repeat that guidance.
 */
export function formatDirectorSystemPrompt(pkg: DirectorPackage): string {
  const attached = pkg.attachedSkills;
  const names = pkg.optionalSkills;
  const isPrimaryOrchestrator = pkg.tier === "orchestrator";

  const skillLines: string[] = [];

  if (attached !== undefined && attached.length > 0) {
    skillLines.push(
      `Attached skills: ${attached.join(", ")} (already in context — do not use_skill them again).`,
    );
  }

  if (names === undefined) {
    // no optional line — directors that declare neither field stay silent
  } else if (names.length === 0) {
    skillLines.push("Optional skills: none by default.");
  } else if (isPrimaryOrchestrator) {
    skillLines.push(
      `Optional skills (names for awareness; use_skill is primary-mounted): ${names.join(", ")}.`,
    );
  } else {
    skillLines.push(
      `Optional skills (names for awareness; load brief-named skills straight through use_skill with its exact name; skill_search for discovery when attached skills are not enough): ${names.join(", ")}.`,
    );
  }

  const header = [
    `Identity: agent id \`${pkg.id}\` — spawn as spawn_agent(agent="${pkg.id}").`,
    `Model role: ${pkg.modelRole}.`,
    ...skillLines,
  ].join("\n");
  return `${header}\n\n${pkg.systemPrompt}`;
}

/**
 * Allowlist for a worker's skill_search + use_skill: union of attached and
 * optional names, first-wins, order-preserving. Empty when neither field is
 * declared so workers fail closed (search/use_skill match nothing).
 */
export function skillNamesFromFields(
  attached: readonly string[] | undefined,
  optional: readonly string[] | undefined,
): readonly string[] {
  if (attached === undefined && optional === undefined) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const name of [...(attached ?? []), ...(optional ?? [])]) {
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Allowlist for a director package. Undefined only when `pkg` itself is
 * undefined (plugin path handles skill fields separately). A defined package
 * with neither skill field yields `[]`, not the full catalog.
 */
export function packageAllowedSkillNames(
  pkg: DirectorPackage | undefined,
): readonly string[] | undefined {
  if (pkg === undefined) return undefined;
  return skillNamesFromFields(pkg.attachedSkills, pkg.optionalSkills);
}

/**
 * Product default reasoning effort by package modelRole (CL-5816 slice).
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
  return MODEL_ROLE_DEFAULT_EFFORT[pkg.modelRole];
}
