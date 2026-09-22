import { resolveSkillBody } from "../../extensions/skills.js";

/**
 * Spawn-time attached-skill injection. Resolve named bodies from plugin
 * skillDirs only (no project-local `.agents/.claude/.codex` fallback) and
 * return a prompt section. A miss is noted in the section — never throws,
 * never parks, never asks the parent.
 */
export async function formatAttachedSkillConstraints(args: {
  names: readonly string[];
  cwd: string;
  skillDirs: readonly string[];
}): Promise<string | undefined> {
  if (args.names.length === 0) return undefined;
  const pluginDirs = [...args.skillDirs];
  const blocks: string[] = [
    "# Attached skill constraints",
    "",
    "These skills are already in context. Do not use_skill them again. If a named attached skill is missing below, proceed under AGENTS.md — do not park, do not ask_director.",
  ];
  for (const name of args.names) {
    const body = await resolveSkillBody(args.cwd, name, pluginDirs, {
      pluginDirsOnly: true,
    });
    if (body === undefined) {
      blocks.push(
        "",
        `Attached skill "${name}" could not be resolved. Proceed under AGENTS.md.`,
      );
      continue;
    }
    blocks.push("", `### ${name}`, "", body);
  }
  return blocks.join("\n");
}
