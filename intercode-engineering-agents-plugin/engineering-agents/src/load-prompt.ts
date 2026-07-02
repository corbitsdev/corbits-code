import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = join(PLUGIN_ROOT, "agents");
const SKILLS_DIR = join(PLUGIN_ROOT, "skills");

export const INTERCODE_APPENDIX = `

## Intercode notes

- Spawn other team members with the \`task\` tool and \`agent\`: karen, greybeard, critique, intern, neckbeard (only the primary Intercode session may call \`task\`).
- If you are running as a \`task\` sub-agent, you cannot call \`task\` again; return a concrete report to the caller.
- Tools use Intercode names: read_file, write_file, edit_file, run_shell, search_files, grep, list_dir, lsp.
- Upstream @explore / @general are not profiles here; use \`task\` with intern or an unnamed worker for mechanical or exploratory work.
- Bundled skill text from \`skills/\` is included in your system prompt where the upstream agent loads skills at session start.
`;

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw.trim();
  const end = raw.indexOf("---", 3);
  if (end === -1) return raw.trim();
  return raw.slice(end + 3).trim();
}

export function loadSkill(skillName: string): string {
  const raw = readFileSync(join(SKILLS_DIR, skillName, "SKILL.md"), "utf8");
  return stripFrontmatter(raw);
}

/** Agent markdown plus optional bundled skills (1:1 with upstream session-init). */
export function loadAgentRole(agentBasename: string, bundledSkills: readonly string[] = []): string {
  const raw = readFileSync(join(AGENTS_DIR, agentBasename), "utf8");
  const body = stripFrontmatter(raw);
  const skillBlocks =
    bundledSkills.length === 0
      ? ""
      : bundledSkills
          .map(
            (name) =>
              `# Bundled skill: ${name}\n\n${loadSkill(name)}`,
          )
          .join("\n\n---\n\n");
  const combined = skillBlocks.length > 0 ? `${skillBlocks}\n\n---\n\n${body}` : body;
  return `${combined}${INTERCODE_APPENDIX}`;
}

export function loadAgentPrompt(basename: string, withAppendix = true): string {
  const raw = readFileSync(join(AGENTS_DIR, basename), "utf8");
  const body = stripFrontmatter(raw);
  return withAppendix ? `${body}${INTERCODE_APPENDIX}` : body;
}