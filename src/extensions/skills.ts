import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FALLBACK_SKILL_DIRS = [".agents/skills", ".claude/skills", ".codex/skills"] as const;

// Skills that ship with the binary, resolved as a last-resort fallback so a
// plugin- or project-provided skill of the same name takes precedence.
const BUNDLED_SKILLS_DIR = join(import.meta.dirname, "../../skills/bundled");

function parseSkillRef(ref: string): { plugin: string | undefined; name: string } {
  const idx = ref.indexOf(":");
  if (idx === -1) return { plugin: undefined, name: ref };
  return { plugin: ref.slice(0, idx), name: ref.slice(idx + 1) };
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw.trim();
  const end = raw.indexOf("---", 3);
  if (end === -1) return raw.trim();
  return raw.slice(end + 3).trim();
}

async function readSkillFile(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const body = stripFrontmatter(raw);
    return body.length > 0 ? body : undefined;
  } catch {
    return undefined;
  }
}

// Resolve a skill reference (e.g. gaas:scribe or scribe) to prompt text for injection.
export async function resolveSkillBody(cwd: string, ref: string, pluginDirs: string[] = []): Promise<string | undefined> {
  const { name } = parseSkillRef(ref);

  // Precedence: installed plugins, then project-local dirs, then bundled.
  const candidates = [
    ...pluginDirs.map((dir) => join(dir, "skills", name, "SKILL.md")),
    ...FALLBACK_SKILL_DIRS.map((rel) => join(cwd, rel, name, "SKILL.md")),
    join(BUNDLED_SKILLS_DIR, name, "SKILL.md"),
  ];

  for (const candidate of candidates) {
    const body = await readSkillFile(candidate);
    if (body !== undefined) return body;
  }

  return undefined;
}

export function formatSkillDirective(ref: string, body: string): string {
  return [`[Skill: ${ref}]`, "", body].join("\n");
}