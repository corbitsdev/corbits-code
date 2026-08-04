import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { homedir } from "node:os";

import { SETTINGS_DIR_NAME } from "../branding.js";

// Project identity for the global session tree under
// ~/.corbits/projects/<project-key>/<thread-id>/. Prefer a git *common* root so
// main + linked worktrees share resume history; fall back to the workspace
// realpath for non-git trees. The key is a readable slug plus a short hash of
// the absolute root so common folder names ("src", "app") do not collide.

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

/**
 * Shared project root for session identity.
 *
 * Linked worktrees each have their own toplevel path; `--git-common-dir` points
 * at the main repo's `.git`, so parent-of-common-dir is stable across worktrees.
 */
export function projectRootFor(cwd: string): string {
  try {
    const commonRaw = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (commonRaw.length > 0) {
      const commonAbs = realpathOr(
        isAbsolute(commonRaw) ? commonRaw : resolve(cwd, commonRaw),
      );
      // Standard layout: <repo>/.git  →  project root is parent.
      // Bare repo: common dir is the bare store itself.
      const root =
        basename(commonAbs) === ".git" ? dirname(commonAbs) : commonAbs;
      return realpathOr(root);
    }
  } catch {
    // Not a git worktree (or git unavailable) — use the workspace path.
  }
  return realpathOr(cwd);
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
export function projectSessionsRoot(cwd: string, home: string = homedir()): string {
  return join(projectsRoot(home), projectKeyFor(cwd));
}
