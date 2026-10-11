import { realpath } from "node:fs/promises";
import { readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathIsInsideOrEqual } from "../util/path-contain.js";

const FALLBACK_SKILL_DIRS = [
  ".agents/skills",
  ".claude/skills",
  ".codex/skills",
] as const;

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
  /**
   * Skip project-local `.agents/.claude/.codex/skills` fallbacks. Attached
   * bundled product skills use this so a repo SKILL.md cannot
   * become system-prompt constraints.
   */
  pluginDirsOnly?: boolean;
}

// Skill subfolders live under enabled plugin dirs first, then project-local dirs
// unless the caller opts out of the fallback.
function skillBaseDirs(
  cwd: string,
  pluginDirs: string[],
  includeProjectFallback = true,
): string[] {
  const pluginBases = pluginDirs.map((dir) => join(dir, "skills"));
  if (!includeProjectFallback) return pluginBases;
  return [...pluginBases, ...FALLBACK_SKILL_DIRS.map((rel) => join(cwd, rel))];
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
    if (match) {
      const key = match[1];
      const value = match[2];
      if ((key === "name" || key === "description") && value !== undefined) {
        out[key] = value.trim();
      }
    }
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
  const skillMd =
    basename(resolved) === "SKILL.md" ? resolved : join(resolved, "SKILL.md");
  if (!pathIsInsideOrEqual(skillMd, root)) return undefined;

  // Symlink escape bar: realpath both sides when the candidate exists.
  try {
    const [realSkill, realRoot] = await Promise.all([
      realpath(skillMd),
      realpath(root),
    ]);
    if (!pathIsInsideOrEqual(realSkill, realRoot)) return undefined;
    return bodyFromSkillPath(realSkill);
  } catch {
    // Missing path (or unreadable root) → not a resolvable skill.
    return undefined;
  }
}

// Resolve a skill reference (e.g. scribe or gaas:scribe) to its body text — the
// frontmatter is stripped, leaving the instructions to inject into context.
// Bare names search `skillBaseDirs`; path-like refs resolve only under
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
  for (const base of skillBaseDirs(
    cwd,
    pluginDirs,
    options?.pluginDirsOnly !== true,
  )) {
    const body = await bodyFromSkillPath(join(base, name, "SKILL.md"));
    if (body !== undefined) return body;
  }
  return undefined;
}

// Discover every available skill (name + one-line description). Deduped by name:
// the first base dir that provides a skill wins, so a higher-precedence dir
// shadows a lower one. `disable-model-invocation: true` skills are omitted from
// the listing but still claim the name so a lower-priority same-name skill
// cannot leak in; explicit `use_skill` / `resolveSkillBody` loads still work.
export async function discoverSkills(
  cwd: string,
  pluginDirs: string[] = [],
): Promise<SkillSummary[]> {
  const seen = new Set<string>();
  const skills: SkillSummary[] = [];
  for (const base of skillBaseDirs(cwd, pluginDirs)) {
    const entries = await readdir(base, { withFileTypes: true }).catch(
      () => undefined,
    );
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

// Process-lifetime skill catalog cache keyed by resolved cwd + plugin dirs, so
// repeated spawn_agent waves skip discovery. The fallback base dirs are
// cwd-relative, so the key includes the cwd. Callers get a copy; the cached
// canonical is never handed out, so one worker cannot mutate another's catalog.
const skillSnapshotCache = new Map<string, readonly SkillSummary[]>();

function skillSnapshotCacheKey(
  cwd: string,
  pluginDirs: readonly string[],
): string {
  return `${resolve(cwd)}\0${pluginDirs.join("\0")}`;
}

export async function discoverSkillsCached(
  cwd: string,
  pluginDirs: readonly string[] = [],
): Promise<SkillSummary[]> {
  const key = skillSnapshotCacheKey(cwd, pluginDirs);
  const cached = skillSnapshotCache.get(key);
  if (cached !== undefined) return cached.map((skill) => ({ ...skill }));
  const fresh = await discoverSkills(cwd, [...pluginDirs]);
  skillSnapshotCache.set(
    key,
    fresh.map((skill) => ({ ...skill })),
  );
  return fresh;
}

/** Test hook: drop every cached skill snapshot so suites start unpolluted. */
export function resetSkillDiscoveryCacheForTests(): void {
  skillSnapshotCache.clear();
}
