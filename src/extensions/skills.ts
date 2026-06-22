import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FALLBACK_SKILL_DIRS = [".agents/skills", ".claude/skills", ".codex/skills"] as const;

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
  const { plugin, name } = parseSkillRef(ref);

  if (plugin === "gaas" && name === "scribe") {
    const bundled = join(import.meta.dirname, "../../skills/bundled/scribe/SKILL.md");
    const fromBundled = await readSkillFile(bundled);
    if (fromBundled !== undefined) return fromBundled;
  }

  for (const dir of pluginDirs) {
    const candidate = join(dir, "skills", name, "SKILL.md");
    const body = await readSkillFile(candidate);
    if (body !== undefined) return body;
  }

  for (const rel of FALLBACK_SKILL_DIRS) {
    const candidate = join(cwd, rel, name, "SKILL.md");
    const body = await readSkillFile(candidate);
    if (body !== undefined) return body;
  }

  return undefined;
}

export function formatSkillDirective(ref: string, body: string): string {
  return [`[Skill: ${ref}]`, "", body].join("\n");
}