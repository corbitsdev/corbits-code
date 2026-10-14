import type { DirectorPackage } from "./types.js";
import type { ModelRole } from "./types.js";
import type { ReasoningEffort } from "../../provider/reasoning-effort.js";

/**
 * Prefix every director system prompt with a stable identity block: agent
 * id, model role, attached skills, optional skills — no ambiguity about
 * which package it is or how the parent should re-spawn it. Attached skill
 * bodies are injected at spawn (run.ts), not here; this block carries names
 * only.
 */
export function formatDirectorSystemPrompt(pkg: DirectorPackage): string {
  return `${formatDirectorIdentityHeader(pkg)}\n\n${pkg.systemPrompt}`;
}

/**
 * Identity block for a director package: agent id, model role, attached
 * skills, optional skills — no card body. formatDirectorSystemPrompt composes
 * header + card; run.ts composes the same header over a family-tuned leaf
 * role body so identity stays single-authority.
 */
export function formatDirectorIdentityHeader(pkg: DirectorPackage): string {
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
  return header;
}

/**
 * Compose a family-tuned leaf role body under the single identity header:
 * the header is the block before the first blank line of the already
 * formatted director prompt (identity stays formatted once, per package), so
 * a family role body replaces only the card body. Falls back to the raw body
 * when no formatted prompt is available.
 */
export function composeLeafRoleBody(
  formattedPrompt: string | undefined,
  leafRoleBody: string,
): string {
  if (formattedPrompt === undefined) return leafRoleBody;
  const boundary = formattedPrompt.indexOf("\n\n");
  if (boundary <= 0) return leafRoleBody;
  return `${formattedPrompt.slice(0, boundary)}\n\n${leafRoleBody}`;
}

/**
 * Allowlist for a worker's skill_search + use_skill: union of attached and
 * optional names, first-wins, order-preserving. Undefined when the package
 * declares neither field (plugin profiles / directors with no skill scope).
 */
export function packageAllowedSkillNames(
  pkg: DirectorPackage | undefined,
): readonly string[] | undefined {
  if (pkg === undefined) return undefined;
  if (pkg.attachedSkills === undefined && pkg.optionalSkills === undefined) {
    return undefined;
  }
  const seen = new Set<string>();
  const names: string[] = [];
  for (const name of [
    ...(pkg.attachedSkills ?? []),
    ...(pkg.optionalSkills ?? []),
  ]) {
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** Product default reasoning effort by package modelRole. */
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
