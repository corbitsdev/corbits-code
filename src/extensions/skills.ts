import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const FALLBACK_SKILL_DIRS = [".agents/skills", ".claude/skills", ".codex/skills"] as const;

export type SkillSummary = { name: string; description: string };

export type ResolveSkillBodyOptions = {
  /**
   * Plugin root directory for path-like skill refs (`./skills/style`,
   * `skills/style`, `../sibling`). Required for path-like resolution;
   * ignored for bare skill names.
   */
  pluginRoot?: string;
};

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

/** Path-like refs: `./x`, `../x`, or any ref containing `/`. Bare names stay bare. */
export function isPathLikeSkillRef(name: string): boolean {
  return name.startsWith("./") || name.startsWith("../") || name.includes("/");
}

/** True when `abs` is the root or a path strictly under it (prefix + separator). */
function pathIsInsideOrEqual(abs: string, root: string): boolean {
  const a = resolve(abs);
  const r = resolve(root);
  if (a === r) return true;
  const prefix = r.endsWith("/") ? r : `${r}/`;
  return a.startsWith(prefix);
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

async function bodyFromSkillPath(path: string): Promise<string | undefined> {
  const raw = await readRaw(path);
  if (raw === undefined) return undefined;
  const body = stripFrontmatter(raw);
  return body.length > 0 ? body : undefined;
}

/**
 * Resolve a path-like skill ref against `pluginRoot`. Absolute refs and
 * escapes outside the root are rejected. Accepts a SKILL.md file path or a
 * directory that contains SKILL.md.
 */
async function resolvePathLikeSkillBody(
  pluginRoot: string,
  ref: string,
): Promise<string | undefined> {
  if (isAbsolute(ref)) return undefined;
  const root = resolve(pluginRoot);
  const resolved = resolve(root, ref);
  if (!pathIsInsideOrEqual(resolved, root)) return undefined;

  // File form: ref points at SKILL.md itself.
  if (resolved.endsWith("SKILL.md") || resolved.endsWith(`${"/"}SKILL.md`)) {
    if (!pathIsInsideOrEqual(resolved, root)) return undefined;
    return bodyFromSkillPath(resolved);
  }

  // Directory form: ref points at a skill folder containing SKILL.md.
  const skillMd = join(resolved, "SKILL.md");
  if (!pathIsInsideOrEqual(skillMd, root)) return undefined;
  return bodyFromSkillPath(skillMd);
}

// Resolve a skill reference (e.g. scribe or gaas:scribe) to its body text — the
// frontmatter is stripped, leaving the instructions to inject into context.
//
// Bare names search `skillBaseDirs` (plugin dirs then project-local fallbacks).
// Path-like refs (`./skills/style`, `skills/foo`) resolve only under
// `options.pluginRoot` with containment checks; absolute and escape paths fail.
export async function resolveSkillBody(
  cwd: string,
  ref: string,
  pluginDirs: string[] = [],
  options?: ResolveSkillBodyOptions,
): Promise<string | undefined> {
  const name = parseSkillRef(ref);
  if (isPathLikeSkillRef(name)) {
    const pluginRoot = options?.pluginRoot;
    if (pluginRoot === undefined) return undefined;
    return resolvePathLikeSkillBody(pluginRoot, name);
  }
  for (const base of skillBaseDirs(cwd, pluginDirs)) {
    const body = await bodyFromSkillPath(join(base, name, "SKILL.md"));
    if (body !== undefined) return body;
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
