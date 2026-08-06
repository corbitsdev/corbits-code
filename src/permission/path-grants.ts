import { realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { Settings } from "../config/settings.js";
import { projectKeyFor } from "../session/project-key.js";

// Read-only path grants for outside-workspace files and directories, keyed by
// project identity in global settings. Never written under the git worktree so
// teammates do not inherit another operator's grants.

export type PathGrant = {
  path: string;
  mode: "read";
  kind: "file" | "dir";
};

// Grant targets may not exist yet (e.g. adding a file grant under a dir grant
// for a path the operator has not created). Realpath the nearest existing
// ancestor and rejoin the missing tail so macOS symlink roots
// (/tmp -> /private/tmp, /var -> /private/var) still compare equal.
function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    const tailStart = parent.endsWith(sep) ? parent.length : parent.length + 1;
    return join(realpathOr(parent), path.slice(tailStart));
  }
}

export function isPathCoveredByReadGrant(
  absPath: string,
  grants: readonly PathGrant[],
): boolean {
  const real = realpathOr(absPath);
  for (const grant of grants) {
    const root = realpathOr(grant.path);
    if (grant.kind === "file") {
      if (real === root) return true;
      continue;
    }
    if (real === root || real.startsWith(root + sep)) return true;
  }
  return false;
}

export function getProjectPathGrants(
  settings: Settings | null | undefined,
  projectKey: string,
): PathGrant[] {
  const list = settings?.projectPathGrants?.[projectKey];
  return list === undefined ? [] : [...list];
}

export function getProjectPathGrantsForCwd(
  settings: Settings | null | undefined,
  cwd: string,
): PathGrant[] {
  return getProjectPathGrants(settings, projectKeyFor(cwd));
}

export function addProjectPathGrant(
  settings: Settings,
  projectKey: string,
  grant: PathGrant,
): Settings {
  const normalized: PathGrant = {
    path: realpathOr(grant.path),
    mode: "read",
    kind: grant.kind,
  };
  const current = getProjectPathGrants(settings, projectKey);
  if (current.some((g) => g.path === normalized.path && g.kind === normalized.kind)) {
    return settings;
  }
  // Prefer a dir grant over a redundant file grant under the same root.
  const withoutCovered =
    normalized.kind === "dir"
      ? current.filter(
          (g) =>
            !(
              g.kind === "file" &&
              (g.path === normalized.path || g.path.startsWith(normalized.path + sep))
            ),
        )
      : current;
  if (
    normalized.kind === "file" &&
    withoutCovered.some(
      (g) =>
        g.kind === "dir" &&
        (normalized.path === g.path || normalized.path.startsWith(g.path + sep)),
    )
  ) {
    return settings;
  }
  return {
    ...settings,
    projectPathGrants: {
      ...settings.projectPathGrants,
      [projectKey]: [...withoutCovered, normalized],
    },
  };
}

export function removeProjectPathGrant(
  settings: Settings,
  projectKey: string,
  path: string,
): Settings {
  const target = realpathOr(path);
  const current = getProjectPathGrants(settings, projectKey);
  const next = current.filter((g) => g.path !== target);
  if (next.length === current.length) return settings;
  const projectPathGrants = { ...settings.projectPathGrants };
  if (next.length === 0) {
    delete projectPathGrants[projectKey];
  } else {
    projectPathGrants[projectKey] = next;
  }
  const empty = Object.keys(projectPathGrants).length === 0;
  if (empty) {
    const { projectPathGrants: _drop, ...rest } = settings;
    return rest;
  }
  return { ...settings, projectPathGrants };
}

export function mintPathGrant(
  absPath: string,
  kind: "file" | "dir",
): PathGrant {
  return { path: realpathOr(absPath), mode: "read", kind };
}
