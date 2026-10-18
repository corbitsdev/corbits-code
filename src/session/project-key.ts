import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { homedir } from "node:os";

import { SETTINGS_DIR_NAME } from "../branding.js";

// Project identity for the global session tree under
// ~/.corbits/projects/<project-key>/<thread-id>/. Prefer this checkout's git
// toplevel so linked worktrees each have their own resume list; fall back to
// the workspace realpath for non-git trees. The key is a readable slug plus a
// short hash of the absolute root so common folder names do not collide.

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function slugSegment(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "project";
}

// Repeated boot lookups of one cwd must not each spawn git. Keyed by the
// resolved directory when it exists so equivalent spellings share one entry.
// Missing paths keep the original string, because that string is the result.
const projectRootByResolvedCwd = new Map<string, string>();

function resolvedCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

function projectRootUncached(cwd: string): string {
  try {
    const toplevelRaw = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (toplevelRaw.length > 0) {
      const toplevelAbs = isAbsolute(toplevelRaw)
        ? toplevelRaw
        : resolve(cwd, toplevelRaw);
      return realpathOr(toplevelAbs);
    }
  } catch {
    // Not a git checkout (or git unavailable) — use the workspace path.
  }
  return realpathOr(cwd);
}

/**
 * Checkout project root for session identity.
 *
 * Nested cwd under a git toplevel shares that root (and therefore the same
 * project key). Linked worktrees each have their own `--show-toplevel`.
 */
export function projectRootFor(cwd: string): string {
  const key = resolvedCwd(cwd);
  const cached = projectRootByResolvedCwd.get(key);
  if (cached !== undefined) return cached;
  const root = projectRootUncached(cwd);
  projectRootByResolvedCwd.set(key, root);
  return root;
}

export function projectKeyFor(cwd: string): string {
  const root = projectRootFor(cwd);
  const base = slugSegment(basename(root));
  const parent = slugSegment(basename(dirname(root)));
  const slug = parent === "project" ? base : `${parent}-${base}`;
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

export function projectsRoot(home: string = homedir()): string {
  return join(home, SETTINGS_DIR_NAME, "projects");
}

/** Global directory for all sessions of one project. */
export function projectSessionsRoot(
  cwd: string,
  home: string = homedir(),
): string {
  return join(projectsRoot(home), projectKeyFor(cwd));
}
