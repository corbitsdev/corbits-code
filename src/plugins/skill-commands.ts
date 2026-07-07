import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandDefinition, CommandResult } from "../tui/commands/registry.js";
import { splitFrontmatter } from "./frontmatter.js";

// Skills authored as `skills/<name>/SKILL.md` are normally model-invoked via the
// `use_skill` tool. A skill may opt into ALSO being a user-facing slash command
// by tagging its frontmatter — either Claude Code's `disable-model-invocation:
// true` or the Agent Skills spec's `user-invocable: true`. Both mean "the user
// triggers this explicitly," so we surface them as `/<skill-name> [args]` that
// sends the skill body (plus any args) to the agent.
//
// This is an additional surface only: `discoverSkills` still lists every skill
// for model auto-invocation (per the chosen design). Tagged skills simply gain
// a `/` entry point in addition to `use_skill`.

const COMMAND_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isUserInvocable(fm: Record<string, unknown> | null): boolean {
  if (fm === null) return false;
  return fm["disable-model-invocation"] === true || fm["user-invocable"] === true;
}

// `$ARGUMENTS` (Claude Code convention) interpolates inline when the author used
// it; otherwise args append after the body so the skill instructions run against
// the user's target (e.g. an issue id).
function buildPrompt(body: string, args: string): string {
  if (body.includes("$ARGUMENTS")) {
    return args.length > 0 ? body.replaceAll("$ARGUMENTS", args) : body.replaceAll("$ARGUMENTS", "");
  }
  return args.length > 0 ? `${body}\n\n${args}` : body;
}

// Read `skills/<name>/SKILL.md` and return a slash command for each skill tagged
// user-invocable. Returns null when the plugin has no skills root or no tagged
// skills, so the orchestrator can treat skill-commands as optional.
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
    if (!isUserInvocable(frontmatter)) continue;

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

    const capturedBody = body;
    commands.push({
      name,
      description,
      handler: (args: string): CommandResult => ({ type: "send", text: buildPrompt(capturedBody, args) }),
    });
  }

  if (commands.length === 0) return null;
  commands.sort((a, b) => a.name.localeCompare(b.name));
  return commands;
}
