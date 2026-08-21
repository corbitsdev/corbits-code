import type { DirectorPackage } from "./types.js";
import type { ModelRole } from "./types.js";
import type { ReasoningEffort } from "../../provider/reasoning-effort.js";

function skillsHeader(pkg: DirectorPackage): string | null {
  const required = pkg.requiredSkills ?? [];
  const optional = pkg.optionalSkills ?? [];
  const listed = pkg.requiredSkills !== undefined || pkg.optionalSkills !== undefined;
  if (!listed) return null;
  if (required.length === 0 && optional.length === 0) {
    return "Skills: none listed. use_skill still works if the session has others.";
  }
  const lines: string[] = [];
  if (required.length > 0) {
    lines.push(
      `Required skills — load with use_skill BEFORE other work: ${required.join(", ")}.`,
    );
  }
  if (optional.length > 0) {
    lines.push(
      `Optional skills — load with use_skill when they apply: ${optional.join(", ")}.`,
    );
  }
  return lines.join("\n");
}

/**
 * Prefix every director system prompt with a stable identity block so the model
 * always sees who it is first — primacy, not an appendix.
 */
export function formatDirectorSystemPrompt(pkg: DirectorPackage): string {
  const skillsLine = skillsHeader(pkg);
  const greeting = `You are ${pkg.name}.`;
  const bodyAlreadyGreets = pkg.systemPrompt.startsWith(`You are ${pkg.name}`);
  const header = [
    ...(bodyAlreadyGreets ? [] : [greeting]),
    `Spawn as task(agent="${pkg.id}").`,
    ...(skillsLine !== null ? [skillsLine] : []),
  ].join("\n");
  return `${header}\n\n${pkg.systemPrompt}`;
}

export const MODEL_ROLE_DEFAULT_EFFORT = {
  orchestrator: "high",
  plan: "high",
  review: "high",
  implement: "medium",
  explore: "medium",
  docs: "medium",
  test: "medium",
  intern: "low",
} as const satisfies Record<ModelRole, ReasoningEffort>;

export function defaultEffortForDirector(pkg: DirectorPackage): ReasoningEffort {
  return MODEL_ROLE_DEFAULT_EFFORT[pkg.modelRole];
}
