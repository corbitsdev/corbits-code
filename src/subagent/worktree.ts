/**
 * Git worktree lifecycle for isolated sub-agent dispatch: create a fresh
 * worktree from the dispatcher's HEAD, and remove it again once the
 * sub-agent finishes, unless it left uncommitted changes behind.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WorktreeExec = (
  args: string[],
  options: { cwd: string },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: WorktreeExec = (args, options) => execFileAsync("git", args, options);

export class WorktreeError extends Error {}

export type SubAgentWorktree = {
  path: string;
  // The repo's `git stash list` output at the moment this worktree was
  // created (see stashList). Stash refs live on the shared repo, not the
  // worktree, so cleanup diffs against this baseline to notice stash entries
  // the sub-agent created while it ran — see cleanupSubAgentWorktree.
  stashBaseline: string[];
};

// The repo's stash list as an array of "stash@{N}: <message>" lines (empty
// when there are none, or when the lookup itself fails — a failed lookup
// must never make cleanup MORE willing to remove a worktree, so it degrades
// to "no visible change" rather than to "worktree is clean").
async function stashList(repoCwd: string, exec: WorktreeExec): Promise<string[]> {
  try {
    const { stdout } = await exec(["stash", "list"], { cwd: repoCwd });
    return stdout.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

// Creates a fresh git worktree at `path`, detached at the current HEAD of
// `repoCwd`. Fails closed: `repoCwd` must be inside a git working tree and
// `git worktree add` must succeed, or this throws WorktreeError with a
// message safe to surface directly to the operator.
export async function createSubAgentWorktree(
  repoCwd: string,
  path: string,
  exec: WorktreeExec = defaultExec,
): Promise<SubAgentWorktree> {
  try {
    await exec(["rev-parse", "--show-toplevel"], { cwd: repoCwd });
  } catch (err) {
    throw new WorktreeError(
      `Cannot create an isolated sub-agent worktree: "${repoCwd}" is not inside a git repository.`,
      { cause: err },
    );
  }
  try {
    await exec(["worktree", "add", "--detach", path, "HEAD"], { cwd: repoCwd });
  } catch (err) {
    throw new WorktreeError(
      `Failed to create sub-agent worktree at "${path}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const stashBaseline = await stashList(repoCwd, exec);
  return { path, stashBaseline };
}

export type WorktreeCleanupResult =
  | { status: "removed"; path: string }
  | { status: "preserved"; path: string; notice: string };

// Removes the worktree if it has no uncommitted changes and no new stash
// entries; otherwise leaves it in place (the sub-agent's work is not ours to
// discard) and returns a notice the caller should surface to the operator.
// `git status` never reports a `git stash` the sub-agent ran mid-task — the
// stash itself survives in the repo's shared refs/stash either way, but
// without this check it goes silently orphaned with no indication of which
// worktree it came from. `stashBaseline` (from createSubAgentWorktree) is
// diffed against the current stash list so only entries created since this
// worktree was checked out are attributed to it.
export async function cleanupSubAgentWorktree(
  repoCwd: string,
  path: string,
  stashBaseline: readonly string[] = [],
  exec: WorktreeExec = defaultExec,
): Promise<WorktreeCleanupResult> {
  let dirty: boolean;
  try {
    // --ignored counts gitignored-but-present files (e.g. dist/, logs) as
    // content worth preserving — a worktree holding only ignored output is
    // not "clean" just because git status ignores it by default.
    const { stdout } = await exec(["status", "--porcelain", "--ignored"], { cwd: path });
    dirty = stdout.trim().length > 0;
  } catch {
    // Cannot inspect the worktree's status — preserve it rather than risk
    // discarding work we could not verify was safe to remove.
    dirty = true;
  }
  if (dirty) {
    return {
      status: "preserved",
      path,
      notice: `Sub-agent worktree at ${path} has uncommitted changes and was left in place.`,
    };
  }
  const currentStashes = await stashList(repoCwd, exec);
  const baselineSet = new Set(stashBaseline);
  const newStashes = currentStashes.filter((entry) => !baselineSet.has(entry));
  if (newStashes.length > 0) {
    return {
      status: "preserved",
      path,
      notice: `Sub-agent worktree at ${path} was left in place: it created ${
        newStashes.length === 1 ? "a stash entry" : `${newStashes.length} stash entries`
      } that would otherwise go unrecovered (${newStashes.join("; ")}).`,
    };
  }
  try {
    await exec(["worktree", "remove", path], { cwd: repoCwd });
  } catch (err) {
    return {
      status: "preserved",
      path,
      notice: `Sub-agent worktree at ${path} could not be removed automatically: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  return { status: "removed", path };
}
