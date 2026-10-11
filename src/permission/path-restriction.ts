import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { RootsProvider } from "./worktree-roots.js";
import { projectSessionsRoot } from "../session/project-key.js";

// Paths the agent must not touch without explicit operator approval, even
// though read tools are otherwise allow-tier and write/edit auto-allow in
// auto mode:
//
//   - anything outside the session workspace (the primary cwd and its
//     registered worktrees) — restricted for reads and writes
//   - writes under the session state root (global ~/.corbits/projects/… and
//     legacy in-repo .agent-state) — reads stay unrestricted since state
//     holds the transcripts users read to debug a run; the state root is an
//     exception to the outside-workspace rule (global state lives under $HOME)
//
// Gitignore status is deliberately not a factor: build output and scratch
// files are ordinary workspace files. Secret-guard independently hard-blocks
// reads/writes of sensitive files (.env, keys, certs). Results are cached
// per resolved path and access mode because the gate consults this on every
// path-argument tool call.
export interface PathRestriction {
  isRestricted: (path: string, isWrite: boolean) => boolean;
}

const LEGACY_STATE_DIR = ".agent-state";

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// Sentinel from realpathNearestOr for a path that exists but cannot be
// resolved (dangling symlink or loop). Contains a NUL byte, which can never
// appear in a real path, so it cannot collide with a genuine result.
export const UNRESOLVABLE = "\0unresolvable\0";

// A write/edit target usually does not exist yet, so realpath the nearest
// existing ancestor and rejoin the missing tail instead of using the raw
// (possibly symlink-relative) path, which would defeat containment when the
// workspace root itself is reached through a symlink (e.g. macOS /tmp ->
// /private/tmp).
//
// realpath failure is ambiguous: "component doesn't exist yet" (safe) or
// "component exists but is a dangling symlink / loop" (unsafe). lstat
// distinguishes the two: it succeeds for an existing-but-broken symlink and
// fails only when the component is genuinely absent.
export function realpathNearestOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      lstatSync(path);
      return UNRESOLVABLE;
    } catch {
      // Doesn't exist at all — fall through to the nearest-ancestor walk.
    }
    const parent = dirname(path);
    if (parent === path) return path;
    // Root (e.g. "/") already ends in the separator, so slicing past
    // parent.length lands on the tail; elsewhere the separator between
    // parent and tail must be skipped too.
    const tailStart = parent.endsWith(sep) ? parent.length : parent.length + 1;
    const parentReal = realpathNearestOr(parent);
    if (parentReal === UNRESOLVABLE) return UNRESOLVABLE;
    return join(parentReal, path.slice(tailStart));
  }
}

const MAX_SYMLINK_HOPS = 40;

// The deepest path-or-ancestor that is a symlink whose target does not exist.
function danglingLinkOf(path: string): string | undefined {
  let current = path;
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        try {
          realpathSync(current);
        } catch {
          return current;
        }
      }
    } catch {
      // Component absent: keep walking up.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

// realpathNearestOr reports a dangling symlink as UNRESOLVABLE because the
// link's name says nothing about where a write would land: a write through
// `link -> .env` creates `.env`, so judgments needing the landing path follow
// link targets by hand. Loops and unreadable links stay UNRESOLVABLE.
export function realpathFollowingDangling(path: string): string {
  let current = path;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    const real = realpathNearestOr(current);
    if (real !== UNRESOLVABLE) return real;
    const link = danglingLinkOf(current);
    if (link === undefined) return UNRESOLVABLE;
    let target: string;
    try {
      target = resolve(dirname(link), readlinkSync(link));
    } catch {
      return UNRESOLVABLE;
    }
    current = join(target, current.slice(link.length));
  }
  return UNRESOLVABLE;
}

// An empty root must never reach the prefix compare: `"" + sep` is just `sep`,
// which every absolute path starts with, turning containment into allow-all.
// A root of exactly `sep` is not this bug.
const inKnownRoots = (real: string, roots: readonly string[]): boolean =>
  roots.some(
    (root) => root.length > 0 && (real === root || real.startsWith(root + sep)),
  );

// Resolves `path` (relative or absolute, possibly traversing `..`) against
// `cwd` and checks it against the workspace boundary: `cwd` plus every root
// `rootsProvider` reports. Returns the canonical real path (symlink segments
// resolved; a not-yet-created target rejoins its nearest existing ancestor
// with the missing tail) when in bounds, `undefined` otherwise.
//
// Returning the canonical path rather than the lexical `abs` closes a TOCTOU:
// a symlink segment in-bounds at check time can be retargeted before a write
// happens. Callers (e.g. pathEscapePlugin) substitute this value into the
// call so the writer never re-traverses the original symlink.
//
// A relative `../` is resolved and realpath-checked rather than rejected: the
// raw path cannot tell a legitimate sibling worktree from a foreign directory,
// and both resolve to `../something` from inside a worktree checkout.
export function resolveWorkspacePath(
  cwd: string,
  path: string,
  rootsProvider: RootsProvider = () => [],
): string | undefined {
  const abs = resolve(cwd, path);
  const real = realpathNearestOr(abs);
  return isResolvedPathInWorkspace(cwd, real, rootsProvider) ? real : undefined;
}

function isResolvedPathInWorkspace(
  cwd: string,
  real: string,
  rootsProvider: RootsProvider,
): boolean {
  if (real === UNRESOLVABLE) return false;
  const realCwd = realpathOr(resolve(cwd));
  if (real === realCwd || real.startsWith(realCwd + sep)) return true;
  if (inKnownRoots(real, rootsProvider())) return true;
  if (inKnownRoots(real, rootsProvider(true))) return true;
  return false;
}

// Whether `path` (relative to `cwd`) names a not-yet-created sibling worktree:
// a direct child of the parent of `cwd` or of a registered root — the
// "one new dir next to something already trusted" shape `git worktree add
// ../name` uses. There is deliberately no basename denylist or `..` depth
// counter: the parent-directory equality check *is* the depth bound, and the
// home guard below is the one home-config bag it was built against ($HOME's
// own children must never qualify).
export function isPermittedSiblingWorktreePath(
  cwd: string,
  path: string,
  rootsProvider: RootsProvider = () => [],
  home: string = homedir(),
): boolean {
  if (path.length === 0) return false;
  if (/[*?[]/.test(path)) return false;
  if (path.startsWith("~")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return false;

  const abs = resolve(cwd, path);
  const realParent = realpathOr(dirname(abs));
  const realHome = realpathOr(resolve(home));
  if (realParent === realHome) return false;

  const knownRoots = [...rootsProvider(), ...rootsProvider(true)];
  const trustedParents = new Set<string>([
    realpathOr(resolve(cwd, "..")),
    ...knownRoots.map((root) => realpathOr(dirname(root))),
  ]);
  return trustedParents.has(realParent);
}

function underResolvedRoot(real: string, root: string): boolean {
  // Resolve a not-yet-created state root through its nearest existing ancestor
  // so it still compares equal to paths under it.
  const realRoot = realpathNearestOr(root);
  if (realRoot === UNRESOLVABLE || real === UNRESOLVABLE) return false;
  return real === realRoot || real.startsWith(realRoot + sep);
}

// `rootsProvider` supplies the additional workspace roots (registered git
// worktrees) beyond cwd. A worktree created mid-session is missing from the
// provider's set; when a checked path falls outside every known root, ask the
// provider to refresh once (subject to its debounce) and re-check before
// concluding the path is genuinely outside.
//
// `home` is injectable so tests can pin the global state root.
export function createPathRestriction(
  cwd: string,
  rootsProvider: RootsProvider = () => [],
  home: string = homedir(),
): PathRestriction {
  const legacyStateDir = resolve(cwd, LEGACY_STATE_DIR);
  const globalStateDir = projectSessionsRoot(cwd, home);
  // Keyed by absolute path and realpath so a cached "unrestricted" verdict
  // does not persist after a symlink retargets outside the workspace.
  const cache = new Map<string, { realpath: string; verdict: boolean }>();

  const underStateDir = (real: string): boolean =>
    underResolvedRoot(real, legacyStateDir) ||
    underResolvedRoot(real, globalStateDir);

  return {
    isRestricted: (path: string, isWrite: boolean): boolean => {
      const abs = resolve(cwd, path);
      const cacheKey = `${isWrite ? "w" : "r"}:${abs}`;
      // Use realpathNearestOr rather than realpathOr: for a not-yet-created
      // target, realpathOr returns the raw path unchanged — the same cache key
      // before and after a symlink retarget. realpathNearestOr resolves the
      // nearest existing ancestor, so the key changes when a symlink flips.
      const currentRealpath = realpathNearestOr(abs);
      const cached = cache.get(cacheKey);

      // Cache hit only if realpath hasn't changed (symlink not retargeted)
      if (cached !== undefined && cached.realpath === currentRealpath) {
        return cached.verdict;
      }

      // State root: read allow, write ask — even when it lives outside the
      // workspace (global ~/.corbits/projects/...).
      if (underStateDir(currentRealpath)) {
        cache.set(cacheKey, { realpath: currentRealpath, verdict: isWrite });
        return isWrite;
      }

      const outsideWorkspace = !isResolvedPathInWorkspace(
        cwd,
        currentRealpath,
        rootsProvider,
      );
      cache.set(cacheKey, {
        realpath: currentRealpath,
        verdict: outsideWorkspace,
      });
      return outsideWorkspace;
    },
  };
}
