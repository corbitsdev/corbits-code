import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathIsInsideOrEqual } from "../util/path-contain.js";

const SKILL_RELATIVE_DIRS = [
  ".corbits/skills",
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
   * Skip project-local and user-global skill dirs. Attached bundled product
   * skills use this so a repo SKILL.md cannot become system-prompt constraints.
   */
  pluginDirsOnly?: boolean;
}

// Skill subfolders live under enabled plugin dirs first, then project-local
// dirs, then user-global dirs, unless the caller opts out of those fallbacks.
// First-wins: plugin > project (.corbits, .agents, .claude, .codex) > user.
function skillBaseDirs(
  cwd: string,
  pluginDirs: string[],
  includeProjectFallback = true,
): string[] {
  const pluginBases = pluginDirs.map((dir) => join(dir, "skills"));
  if (!includeProjectFallback) return pluginBases;
  const projectBases = SKILL_RELATIVE_DIRS.map((rel) => join(cwd, rel));
  const home = homedir();
  const userBases: string[] = [];
  for (const rel of SKILL_RELATIVE_DIRS) {
    const userPath = join(home, rel);
    const projectPath = join(cwd, rel);
    if (resolve(userPath) === resolve(projectPath)) continue;
    userBases.push(userPath);
  }
  return [...pluginBases, ...projectBases, ...userBases];
}

// User-global skill base dirs (`~/.corbits/skills`, …). Project-local skill
// dirs resolve under the session cwd (already inside the workspace); these
// home-based dirs live outside it, so read-only file tools need them as
// trusted roots to open sibling files (see assembleSessionGate).
export function userSkillBaseDirs(home: string = homedir()): string[] {
  return SKILL_RELATIVE_DIRS.map((rel) => join(home, rel));
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
 * A resolved skill: the SKILL.md body (frontmatter stripped) plus the skill
 * directory that won, so callers can point the model at sibling files
 * (e.g. brand-guidelines.md) living next to SKILL.md.
 */
export interface ResolvedSkill {
  body: string;
  dir: string;
}

/**
 * Resolve a path-like skill ref against `pluginRoot`. Absolute refs and
 * escapes outside the root are rejected. Accepts a SKILL.md file path or a
 * directory that contains SKILL.md. When the candidate exists, both sides are
 * realpath'd so a symlink under the root cannot escape to outside content.
 */
async function resolvePathLikeSkill(
  pluginRoot: string,
  ref: string,
): Promise<ResolvedSkill | undefined> {
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
    const body = await bodyFromSkillPath(realSkill);
    if (body === undefined) return undefined;
    return { body, dir: dirname(realSkill) };
  } catch {
    // Missing path (or unreadable root) → not a resolvable skill.
    return undefined;
  }
}

// Resolve a skill reference (e.g. scribe or gaas:scribe) to its body text — the
// frontmatter is stripped, leaving the instructions to inject into context.
//
// Bare names search `skillBaseDirs` (plugin dirs then, unless pluginDirsOnly,
// project-local then user-global fallbacks). Path-like refs (`./skills/style`,
// `skills/foo`) resolve only under `options.pluginRoot` with containment
// checks; absolute and escape paths fail.
export async function resolveSkillWithDir(
  cwd: string,
  ref: string,
  pluginDirs: string[] = [],
  options?: ResolveSkillBodyOptions,
): Promise<ResolvedSkill | undefined> {
  const name = parseSkillRef(ref);
  // Bare `.` / `..` are not skill names and must not fall through to directory search.
  if (name === "." || name === "..") return undefined;
  if (isPathLikeSkillRef(name)) {
    const pluginRoot = options?.pluginRoot;
    if (pluginRoot === undefined) return undefined;
    return resolvePathLikeSkill(pluginRoot, name);
  }
  for (const base of skillBaseDirs(
    cwd,
    pluginDirs,
    options?.pluginDirsOnly !== true,
  )) {
    const dir = join(base, name);
    const body = await bodyFromSkillPath(join(dir, "SKILL.md"));
    if (body !== undefined) return { body, dir };
  }
  return undefined;
}

export async function resolveSkillBody(
  cwd: string,
  ref: string,
  pluginDirs: string[] = [],
  options?: ResolveSkillBodyOptions,
): Promise<string | undefined> {
  const resolved = await resolveSkillWithDir(cwd, ref, pluginDirs, options);
  return resolved?.body;
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

// CL-9010: process-lifetime skill catalog cache keyed by resolved cwd +
// plugin dirs. Spawned workers share the dispatcher's catalog: the first
// same-cwd spawn pays discovery and later spawns reuse the snapshot, so
// spawn_agent dispatch stays non-blocking on repeated waves. The fallback
// base dirs are cwd-relative, so the key must include the cwd — different
// dirs (or a different cwd) always rediscover. Callers get a copy; the
// cached canonical is never handed out, so one worker cannot mutate
// another's catalog. Unbounded in practice the same way the inference
// singleton is: one entry per distinct (cwd, dirs) pair per process.
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
