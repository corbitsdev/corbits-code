import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

// Paths the agent should not touch without explicit operator approval, even
// though the read tools are otherwise allow-tier and write/edit auto-allow in
// auto mode:
//
//   - anything under .agent-state (the agent's own run state) — off-limits
//     unless the operator asks it to self-reflect, trace, or investigate a run.
//   - anything git ignores — gitignored files are noise or secrets-adjacent and
//     should be surfaced only when genuinely required.
//   - anything outside the session workspace (the primary cwd and its
//     registered worktrees) — autonomy is scoped to the workspace boundary, not
//     the whole filesystem.
//
// Git owns gitignore semantics, so we ask `git check-ignore` rather than
// re-implementing ignore-file parsing. Results are cached per resolved path
// because the gate consults this on every tool call with a path argument.

export type PathRestriction = {
  isRestricted: (path: string) => boolean;
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

export function createPathRestriction(cwd: string, worktreeRoots: readonly string[] = []): PathRestriction {
  const stateDir = resolve(cwd, STATE_DIR);
  const workspaceRoots = [cwd, ...worktreeRoots].map((root) => realpathOr(resolve(root)));
  const cache = new Map<string, boolean>();

  const underStateDir = (abs: string): boolean => abs === stateDir || abs.startsWith(stateDir + sep);

  const outsideWorkspace = (abs: string): boolean => {
    const real = realpathNearestOr(abs);
    return !workspaceRoots.some((root) => real === root || real.startsWith(root + sep));
  };

  const gitIgnores = (abs: string): boolean => {
    try {
      // Exit 0 means the path is ignored. A non-zero exit (not ignored, or not a
      // git repo) throws, which we read as "not restricted".
      execFileSync("git", ["check-ignore", "-q", "--", abs], { cwd, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  return {
    isRestricted: (path: string): boolean => {
      const abs = resolve(cwd, path);
      const cached = cache.get(abs);
      if (cached !== undefined) return cached;
      const restricted = underStateDir(abs) || outsideWorkspace(abs) || gitIgnores(abs);
      cache.set(abs, restricted);
      return restricted;
    },
  };
}
