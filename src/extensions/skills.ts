import { realpath } from "node:fs/promises";
import { readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathIsInsideOrEqual } from "../util/path-contain.js";

const FALLBACK_SKILL_DIRS = [".agents/skills", ".claude/skills", ".codex/skills"] as const;

export interface SkillSummary {
  name: string;
  description: string;
}

export interface ResolveSkillBodyOptions {
  /**
   * Plugin root directory for path-like skill refs (`./skills/style`,
   * `skills/style`, `../sibling`). Required for path-like resolution;
   * ignored for bare skill names.
   */
  pluginRoot?: string;
}

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

function parseSkillFrontmatter(raw: string): {
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
} {
  const block = frontmatterBlock(raw);
  if (block === undefined) return {};
  const out: {
    name?: string;
    description?: string;
    disableModelInvocation?: boolean;
  } = {};
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    const match = /^(name|description):\s*(.+)$/.exec(trimmed);
    if (match) out[match[1] as "name" | "description"] = match[2]!.trim();
    if (/^disable-model-invocation:\s*true\s*$/.test(trimmed)) {
      out.disableModelInvocation = true;
    }
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
 * directory that contains SKILL.md. When the candidate exists, both sides are
 * realpath'd so a symlink under the root cannot escape to outside content.
 */
async function resolvePathLikeSkillBody(
  pluginRoot: string,
  ref: string,
): Promise<string | undefined> {
  if (isAbsolute(ref)) return undefined;
  const root = resolve(pluginRoot);
  const resolved = resolve(root, ref);
  if (!pathIsInsideOrEqual(resolved, root)) return undefined;

  // File form (…/SKILL.md) or directory form (…/skill-dir → …/skill-dir/SKILL.md).
  const skillMd = basename(resolved) === "SKILL.md" ? resolved : join(resolved, "SKILL.md");
  if (!pathIsInsideOrEqual(skillMd, root)) return undefined;

  // Symlink escape bar: realpath both sides when the candidate exists.
  try {
    const [realSkill, realRoot] = await Promise.all([realpath(skillMd), realpath(root)]);
    if (!pathIsInsideOrEqual(realSkill, realRoot)) return undefined;
    return bodyFromSkillPath(realSkill);
  } catch {
    // Missing path (or unreadable root) → not a resolvable skill.
    return undefined;
  }
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
  // Bare `.` / `..` are not skill names and must not fall through to directory search.
  if (name === "." || name === "..") return undefined;
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

// Discover every available skill (name + one-line description). Deduped by name:
// the first base dir that provides a skill wins, so a higher-precedence dir
// shadows a lower one. Descriptions feed skill_search and the slash picker; the
// system prompt lists names only. Skills with `disable-model-invocation: true`
// are omitted from the returned listing but still occupy the name in `seen` so
// a lower-priority same-name skill cannot leak in. Explicit `use_skill` /
// `resolveSkillBody` loads still work.
export async function discoverSkills(
  cwd: string,
  pluginDirs: string[] = [],
): Promise<SkillSummary[]> {
  const seen = new Set<string>();
  const skills: SkillSummary[] = [];
  for (const base of skillBaseDirs(cwd, pluginDirs)) {
    const entries = await readdir(base, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      const raw = await readRaw(join(base, entry.name, "SKILL.md"));
      if (raw === undefined) continue;
      const fm = parseSkillFrontmatter(raw);
      // First-wins: claim the name even when skipping the listing.
      seen.add(entry.name);
      if (fm.disableModelInvocation) continue;
      skills.push({ name: entry.name, description: fm.description ?? "" });
    }
  }
  return skills;
}
