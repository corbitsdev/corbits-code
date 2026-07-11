import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

// Git prints realpaths; the caller's cwd may reach the same directory through a
// symlink (e.g. macOS /tmp, /var). Canonicalize both sides so self-exclusion
// compares like with like.
function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// The repo's registered git worktree roots, so the permission gate can treat
// every worktree of this session's repo as inside the workspace boundary. Git
// owns the registry, so we ask `git worktree list` rather than scanning the
// filesystem. A failure (not a git repo, git missing) yields no extra roots —
// the gate then confines autonomy to cwd alone, which is the safe floor.
export async function listWorktreeRoots(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd });
    const roots: string[] = [];
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) roots.push(realpathOr(resolve(line.slice("worktree ".length).trim())));
    }
    const self = realpathOr(resolve(cwd));
    return roots.filter((root) => root !== self);
  } catch {
    return [];
  }
}
