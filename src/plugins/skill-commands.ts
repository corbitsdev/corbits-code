import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  argumentHintFromFrontmatter,
  type CommandDefinition,
  type CommandResult,
} from "../tui/commands/registry.js";
import { splitFrontmatter } from "./frontmatter.js";

// Slash is the operator action surface: `/<skill-name> [args]` sends the skill
// body (plus args) to the agent. Convention/internal skills opt out with
// `user-invocable: false` in frontmatter and are not emitted as slash commands.
// Untagged skills still become slash commands (marketplace BC).
// `disable-model-invocation` does not affect slash emission — that flag only
// skips the skill from `discoverSkills` lazy listing. Explicit `use_skill` /
// `resolveSkillBody` still loads the body by name.

const COMMAND_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// `$ARGUMENTS` (Claude Code convention) interpolates inline when the author used
// it; otherwise args append after the body so the skill instructions run against
// the user's target (e.g. an issue id).
function buildPrompt(body: string, args: string): string {
  if (body.includes("$ARGUMENTS")) {
    return args.length > 0
      ? body.replaceAll("$ARGUMENTS", args)
      : body.replaceAll("$ARGUMENTS", "");
  }
  return args.length > 0 ? `${body}\n\n${args}` : body;
}

// Read `skills/<name>/SKILL.md` and return a slash command for each skill.
// Returns null when the plugin has no skills root or no loadable skill files,
// so the orchestrator can treat skill-commands as optional.
export async function loadSkillCommands(
  pluginDir: string,
  opts: { onWarning?: (msg: string) => void } = {},
): Promise<CommandDefinition[] | null> {
  const warn = opts.onWarning ?? (() => {});
  const skillsDir = join(pluginDir, "skills");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const commands: CommandDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let raw: string;
    try {
      raw = await readFile(join(skillsDir, entry.name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const { frontmatter, body } = splitFrontmatter(raw);
    if (frontmatter === null) {
      warn(`skipping skills/${entry.name}/SKILL.md: malformed frontmatter`);
      continue;
    }
    // Opt-out of the slash surface. Untagged skills still emit a command
    // (marketplace BC); `disable-model-invocation` does not affect this —
    // it only skips discoverSkills listing (see src/extensions/skills.ts).
    if (frontmatter["user-invocable"] === false) continue;

    const name =
      typeof frontmatter.name === "string" && frontmatter.name.trim().length > 0
        ? frontmatter.name.trim()
        : entry.name;
    if (!COMMAND_NAME_PATTERN.test(name)) {
      warn(`skipping skills/${entry.name}: invalid command name "${name}"`);
      continue;
    }
    const description =
      typeof frontmatter.description === "string" && frontmatter.description.trim().length > 0
        ? frontmatter.description.trim()
        : name;

    const argumentHint = argumentHintFromFrontmatter(frontmatter);
    const capturedBody = body;
    const def: CommandDefinition = {
      name,
      description,
      handler: (args: string): CommandResult => ({
        type: "send",
        text: buildPrompt(capturedBody, args),
      }),
    };
    if (argumentHint !== undefined) def.argumentHint = argumentHint;
    commands.push(def);
  }

  if (commands.length === 0) return null;
  commands.sort((a, b) => a.name.localeCompare(b.name));
  return commands;
}
