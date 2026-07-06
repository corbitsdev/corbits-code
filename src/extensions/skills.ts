import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const FALLBACK_SKILL_DIRS = [".agents/skills", ".claude/skills", ".codex/skills"] as const;

export type SkillSummary = { name: string; description: string };

// Skill subfolders live under enabled plugin dirs first, then project-local dirs.
function skillBaseDirs(cwd: string, pluginDirs: string[]): string[] {
  return [
    ...pluginDirs.map((dir) => join(dir, "skills")),
    ...FALLBACK_SKILL_DIRS.map((rel) => join(cwd, rel)),
  ];
}

function parseSkillRef(ref: string): string {
  const idx = ref.indexOf(":");
  return idx === -1 ? ref : ref.slice(idx + 1);
}

function frontmatterBlock(raw: string): string | undefined {
  if (!raw.startsWith("---")) return undefined;
  const end = raw.indexOf("---", 3);
  return end === -1 ? undefined : raw.slice(3, end);
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw.trim();
  const end = raw.indexOf("---", 3);
  if (end === -1) return raw.trim();
  return raw.slice(end + 3).trim();
}

function parseSkillFrontmatter(raw: string): { name?: string; description?: string } {
  const block = frontmatterBlock(raw);
  if (block === undefined) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of block.split("\n")) {
    const match = /^(name|description):\s*(.+)$/.exec(line.trim());
    if (match) out[match[1] as "name" | "description"] = match[2]!.trim();
  }
  return out;
}

async function readRaw(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

// Resolve a skill reference (e.g. scribe or gaas:scribe) to its body text — the
// frontmatter is stripped, leaving the instructions to inject into context.
export async function resolveSkillBody(cwd: string, ref: string, pluginDirs: string[] = []): Promise<string | undefined> {
  const name = parseSkillRef(ref);
  for (const base of skillBaseDirs(cwd, pluginDirs)) {
    const raw = await readRaw(join(base, name, "SKILL.md"));
    if (raw === undefined) continue;
    const body = stripFrontmatter(raw);
    if (body.length > 0) return body;
  }
  return undefined;
}

// Discover every available skill (name + one-line description) for the lazy
// listing in the system prompt. Deduped by name: the first base dir that
// provides a skill wins, so a higher-precedence dir shadows a lower one.
export async function discoverSkills(cwd: string, pluginDirs: string[] = []): Promise<SkillSummary[]> {
  const seen = new Map<string, SkillSummary>();
  for (const base of skillBaseDirs(cwd, pluginDirs)) {
    const entries = await readdir(base, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      const raw = await readRaw(join(base, entry.name, "SKILL.md"));
      if (raw === undefined) continue;
      const fm = parseSkillFrontmatter(raw);
      seen.set(entry.name, { name: entry.name, description: fm.description ?? "" });
    }
  }
  return [...seen.values()];
}
