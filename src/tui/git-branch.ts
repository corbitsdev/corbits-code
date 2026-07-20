// Pure git-branch lookup, kept free of React/Ink so it can be unit tested
// without rendering. useGitBranch (below) is the only piece that owns
// caching/interval refresh for the status bar; it calls fetchGitBranch
// asynchronously and never blocks render on the git process.
import { useEffect, useState } from "react";

export type GitBranchResult = { exitCode: number; stdout: string };
export type SpawnGit = (cwd: string) => Promise<GitBranchResult>;

async function defaultSpawnGit(cwd: string): Promise<GitBranchResult> {
  const proc = Bun.spawn(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ]);
  return { exitCode, stdout };
}

// Detached HEAD (or a repo with zero commits) makes rev-parse print "HEAD"
// itself rather than a branch name; treat that as "no branch" rather than
// showing the literal string "HEAD" in the status bar.
export function parseGitBranchOutput(result: GitBranchResult): string | null {
  if (result.exitCode !== 0) return null;
  const branch = result.stdout.trim();
  if (branch.length === 0 || branch === "HEAD") return null;
  return branch;
}

export async function fetchGitBranch(cwd: string, spawnGit: SpawnGit = defaultSpawnGit): Promise<string | null> {
  try {
    return parseGitBranchOutput(await spawnGit(cwd));
  } catch {
    // Not a git repo, git not installed, etc. — status bar just omits branch.
    return null;
  }
}

const DEFAULT_REFRESH_MS = 5_000;

// Refreshes on a timer and whenever cwd changes; never awaits synchronously
// during render, so a slow or hanging git process can't stall the TUI.
export function useGitBranch(cwd: string, refreshMs = DEFAULT_REFRESH_MS): string | null {
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refresh = () => {
      void fetchGitBranch(cwd).then((next) => {
        if (!cancelled) setBranch(next);
      });
    };

    refresh();
    const timer = setInterval(refresh, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [cwd, refreshMs]);

  return branch;
}
