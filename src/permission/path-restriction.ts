import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { RootsProvider } from "./worktree-roots.js";
import { projectSessionsRoot } from "../session/project-key.js";

// Paths the agent should not touch without explicit operator approval, even
// though the read tools are otherwise allow-tier and write/edit auto-allow in
// auto mode:
//
//   - anything outside the session workspace (the primary cwd and its
//     registered worktrees) — autonomy is scoped to the workspace boundary, not
//     the whole filesystem. Restricted for both reads and writes.
//   - writes under the session state root (global
//     ~/.corbits/projects/<project-key>/… and legacy in-repo .agent-state) —
//     the agent should not rewrite its own session history without operator
//     approval. Reads stay unrestricted since state holds the transcripts
//     users read to debug a run. The state root is an exception to the
//     outside-workspace rule: global state lives under $HOME, not under cwd.
//
// Gitignore status is deliberately not a factor: build output, node_modules,
// and scratch files are ordinary workspace files for both reads and writes.
// Secret-guard independently hard-blocks path-keyed reads/writes of sensitive
// files (.env, keys, certs); shell commands that only mention those paths
// require operator approval instead of a hard deny. Results are cached per
// resolved path and access mode because the gate consults this on every tool
// call with a path argument.
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

// Sentinel returned by realpathNearestOr for a path that exists but couldn't
// be resolved (a dangling symlink, or a symlink loop) rather than one that's
// simply missing. Contains a NUL byte, which can never appear in a real
// filesystem path, so it can't collide with (or be mistaken for a prefix of)
// any genuine result, and every containment compare against it fails.
export const UNRESOLVABLE = "\0unresolvable\0";

// A write/edit target usually doesn't exist yet, so realpath the nearest
// existing ancestor and rejoin the missing tail rather than falling back to
// the raw (possibly symlink-relative) path, which would defeat containment
// checks whenever the workspace root itself is reached through a symlink
// (e.g. macOS's /tmp -> /private/tmp).
//
// realpath failure is ambiguous: it's either "this component doesn't exist
// yet" (safe — the missing tail gets rejoined onto the nearest real ancestor)
// or "this component exists but is a dangling symlink / symlink loop" (unsafe
// — the link's name must not stand in for a normal under-cwd path segment,
// since the walk otherwise reattaches it verbatim and containment sees a
// plain child path with no idea a symlink is involved). lstat distinguishes
// the two: it succeeds for an existing-but-broken symlink and fails only when
// the component is genuinely absent.
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
    // parent.length alone lands on the tail; anywhere else the separator
    // between parent and tail must be skipped too.
    const tailStart = parent.endsWith(sep) ? parent.length : parent.length + 1;
    const parentReal = realpathNearestOr(parent);
    if (parentReal === UNRESOLVABLE) return UNRESOLVABLE;
    return join(parentReal, path.slice(tailStart));
  }
}

// An empty root must never reach the prefix compare: `"" + sep` is just
// `sep` (e.g. "/" on Unix), which every absolute path starts with, turning
// containment into allow-all. A root of exactly `sep` itself is not this bug
// — `startsWith(sep + sep)` correctly rejects unrelated absolute paths.
const inKnownRoots = (real: string, roots: readonly string[]): boolean =>
  roots.some((root) => root.length > 0 && (real === root || real.startsWith(root + sep)));

// Resolves `path` (relative or absolute, possibly traversing `..`) against
// `cwd` and checks it against the workspace boundary: `cwd` itself plus every
// root `rootsProvider` reports (the session's registered git worktrees, or
// any other allowlisted sibling). Returns the CANONICAL real path (symlink
// segments resolved; for a not-yet-created target, the nearest existing
// ancestor's real path rejoined with the missing tail) when the target is in
// bounds, `undefined` otherwise — callers that need a hard allow/deny (rather
// than an allow/ask distinction) can key off that.
//
// Returning the canonical path rather than the lexical `abs` closes a
// TOCTOU: a symlink segment that is in-bounds at check time can be
// retargeted before a write actually happens. Callers (e.g. pathEscapePlugin)
// substitute this return value into the tool call's path argument, so the
// writer that ultimately opens the file never re-traverses the original
// symlink — it uses the already-resolved location.
//
// A relative `../` is deliberately resolved and realpath-checked against the
// allowlist rather than rejected outright: the raw path alone can't tell a
// legitimate sibling worktree from a genuinely foreign directory, and both
// resolve to `../something` from inside a worktree checkout.
export function resolveWorkspacePath(
  cwd: string,
  path: string,
  rootsProvider: RootsProvider = () => [],
): string | undefined {
  const abs = resolve(cwd, path);
  const realCwd = realpathOr(resolve(cwd));
  const real = realpathNearestOr(abs);
  if (real === UNRESOLVABLE) return undefined;
  if (real === realCwd || real.startsWith(realCwd + sep)) return real;
  if (inKnownRoots(real, rootsProvider())) return real;
  if (inKnownRoots(real, rootsProvider(true))) return real;
  return undefined;
}

// Whether `path` (relative to `cwd`) names a not-yet-created sibling worktree
// location: a direct child of the parent directory of `cwd` or of a currently
// registered root — the "one new dir next to something already trusted" shape
// `git worktree add ../name` uses. This is the single containment authority's
// answer to "can auto mode create a brand-new worktree that isn't a registered
// root yet"; there is deliberately no separate basename denylist or `..` depth
// counter — the parent-directory equality check *is* the depth bound (a path
// with any extra segment resolves to a different, non-matching parent), and
// the home-directory guard below is the one home-config bag it purpose-built
// against ($HOME's own children — .ssh, .aws, .config, … must never qualify).
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

function underRoot(abs: string, root: string): boolean {
  // realpathNearestOr on both sides so a not-yet-created state root still
  // compares equal to paths under it (realpathOr alone leaves the root
  // unresolved while the abs path is rebuilt through an existing ancestor).
  const realRoot = realpathNearestOr(root);
  const realAbs = realpathNearestOr(abs);
  if (realRoot === UNRESOLVABLE || realAbs === UNRESOLVABLE) return false;
  return realAbs === realRoot || realAbs.startsWith(realRoot + sep);
}

// `rootsProvider` supplies the additional workspace roots (the session's
// registered git worktrees) beyond cwd itself. A worktree created mid-session
// is missing from whatever set the provider started with; when a checked path
// falls outside every currently-known root, we ask the provider to refresh
// once (subject to its own debounce) and re-check before concluding the path
// is genuinely outside the workspace.
//
// `home` is injectable so tests can pin the global state root without
// mutating process env.
export function createPathRestriction(
  cwd: string,
  rootsProvider: RootsProvider = () => [],
  home: string = homedir(),
): PathRestriction {
  const legacyStateDir = resolve(cwd, LEGACY_STATE_DIR);
  const globalStateDir = projectSessionsRoot(cwd, home);
  // Cache keyed by both absolute path and realpath to invalidate when symlinks
  // change. If only keyed by absolute path, a cached "unrestricted" verdict
  // persists after a symlink retargets outside the workspace.
  const cache = new Map<string, { realpath: string; verdict: boolean }>();

  const underStateDir = (abs: string): boolean =>
    underRoot(abs, legacyStateDir) || underRoot(abs, globalStateDir);

  return {
    isRestricted: (path: string, isWrite: boolean): boolean => {
      const abs = resolve(cwd, path);
      const cacheKey = `${isWrite ? "w" : "r"}:${abs}`;
      // Use realpathNearestOr rather than realpathOr: the target file may not
      // exist yet, in which case realpathOr returns the raw path unchanged —
      // making the cache key identical before and after a symlink retarget.
      // realpathNearestOr resolves up to the nearest existing ancestor, which
      // does change when a symlink flips, invalidating the stale verdict.
      const currentRealpath = realpathNearestOr(abs);
      const cached = cache.get(cacheKey);

      // Cache hit only if realpath hasn't changed (symlink not retargeted)
      if (cached !== undefined && cached.realpath === currentRealpath) {
        return cached.verdict;
      }

      // State root: read allow, write ask — even when the root lives outside
      // the workspace (global ~/.corbits/projects/...).
      if (underStateDir(abs)) {
        cache.set(cacheKey, { realpath: currentRealpath, verdict: isWrite });
        return isWrite;
      }

      const outsideWorkspace = resolveWorkspacePath(cwd, path, rootsProvider) === undefined;
      cache.set(cacheKey, { realpath: currentRealpath, verdict: outsideWorkspace });
      return outsideWorkspace;
    },
  };
}
