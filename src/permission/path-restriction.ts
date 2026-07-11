import { realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { RootsProvider } from "./worktrees.js";

// Paths the agent should not touch without explicit operator approval, even
// though the read tools are otherwise allow-tier and write/edit auto-allow in
// auto mode:
//
//   - anything outside the session workspace (the primary cwd and its
//     registered worktrees) — autonomy is scoped to the workspace boundary, not
//     the whole filesystem. Restricted for both reads and writes.
//   - writes under .agent-state (the agent's own run state) — the agent should
//     not rewrite its own session history without operator approval. Reads stay
//     unrestricted since .agent-state holds the transcripts users read to debug
//     a run.
//
// Gitignore status is deliberately not a factor: build output, node_modules,
// and scratch files are ordinary workspace files for both reads and writes,
// and the secret-guard plugin independently hard-blocks sensitive files (.env,
// keys, certs) regardless of this gate. Results are cached per resolved path
// and access mode because the gate consults this on every tool call with a
// path argument.

export type PathRestriction = {
  isRestricted: (path: string, isWrite: boolean) => boolean;
};

const STATE_DIR = ".agent-state";

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// A write/edit target usually doesn't exist yet, so realpath the nearest
// existing ancestor and rejoin the missing tail rather than falling back to
// the raw (possibly symlink-relative) path, which would defeat containment
// checks whenever the workspace root itself is reached through a symlink
// (e.g. macOS's /tmp -> /private/tmp).
function realpathNearestOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(realpathNearestOr(parent), path.slice(parent.length + 1));
  }
}

// `rootsProvider` supplies the additional workspace roots (the session's
// registered git worktrees) beyond cwd itself. A worktree created mid-session
// is missing from whatever set the provider started with; when a checked path
// falls outside every currently-known root, we ask the provider to refresh
// once (subject to its own debounce) and re-check before concluding the path
// is genuinely outside the workspace.
export function createPathRestriction(cwd: string, rootsProvider: RootsProvider = () => []): PathRestriction {
  const stateDir = resolve(cwd, STATE_DIR);
  const realCwd = realpathOr(resolve(cwd));
  const cache = new Map<string, boolean>();

  const underStateDir = (abs: string): boolean => abs === stateDir || abs.startsWith(stateDir + sep);

  const inKnownRoots = (real: string, roots: readonly string[]): boolean =>
    roots.some((root) => real === root || real.startsWith(root + sep));

  const outsideWorkspace = (abs: string): boolean => {
    const real = realpathNearestOr(abs);
    if (real === realCwd || real.startsWith(realCwd + sep)) return false;
    if (inKnownRoots(real, rootsProvider())) return false;
    return !inKnownRoots(real, rootsProvider(true));
  };

  return {
    isRestricted: (path: string, isWrite: boolean): boolean => {
      const abs = resolve(cwd, path);
      const cacheKey = `${isWrite ? "w" : "r"}:${abs}`;
      const cached = cache.get(cacheKey);
      if (cached !== undefined) return cached;
      const restricted = outsideWorkspace(abs) || (isWrite && underStateDir(abs));
      cache.set(cacheKey, restricted);
      return restricted;
    },
  };
}
