import { execFile, execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function gitWorktreeList(cwd: string): Promise<string> {
  const opts = {
    cwd,
    encoding: "utf8" as const,
    stdio: ["ignore", "pipe", "ignore"] as const,
  };
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], opts);
  return stdout;
}

// Git prints realpaths; the caller's cwd may reach the same directory through a
// symlink (e.g. macOS /tmp, /var). Canonicalize both sides so self-exclusion
// compares like with like. Exported so other permission-layer code comparing
// a path against these roots (e.g. grant cwd matching in authz-grants.ts)
// normalizes through the same function rather than reimplementing it.
export function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function parseWorktreePorcelain(stdout: string, cwd: string): string[] {
  const roots: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree "))
      roots.push(realpathOr(resolve(line.slice("worktree ".length).trim())));
  }
  const self = realpathOr(resolve(cwd));
  return roots.filter((root) => root !== self);
}

// The repo's registered git worktree roots, so the permission gate can treat
// every worktree of this session's repo as inside the workspace boundary. Git
// owns the registry, so we ask `git worktree list` rather than scanning the
// filesystem. A failure (not a git repo, git missing) yields no extra roots —
// the gate then confines autonomy to cwd alone, which is the safe floor.
export async function listWorktreeRoots(cwd: string): Promise<string[]> {
  try {
    const stdout = await gitWorktreeList(cwd);
    return parseWorktreePorcelain(stdout, cwd);
  } catch {
    return [];
  }
}

// Synchronous counterpart used by the path-restriction check, which is itself
// synchronous end-to-end (classify.ts/gate.ts call isRestricted without
// awaiting). Same semantics as listWorktreeRoots, just blocking.
export function listWorktreeRootsSync(cwd: string): string[] {
  try {
    const stdout = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseWorktreePorcelain(stdout, cwd);
  } catch {
    return [];
  }
}

// Called with no argument to read the current best-known roots, or with
// `true` to ask for a refresh before reading. A refresh request only actually
// re-lists when the debounce window has elapsed since the last one — so a
// burst of refresh requests (e.g. several foreign-path checks in a row)
// shells out to git at most once per window.
export type RootsProvider = (forceRefresh?: boolean) => readonly string[];

const DEFAULT_DEBOUNCE_MS = 3000;

// Builds a RootsProvider for `cwd`. The listing is lazy: nothing runs until
// the first read, since most permission checks never leave cwd and should
// never pay for a `git worktree list` call. `lister` is injectable so tests
// can spy on/replace the underlying git call without shelling out for real.
export function createWorktreeRootsProvider(
  cwd: string,
  lister: (cwd: string) => string[] = listWorktreeRootsSync,
  debounceMs: number = DEFAULT_DEBOUNCE_MS,
): RootsProvider {
  let roots: string[] | undefined;
  let lastRefreshAt = -Infinity;

  return (forceRefresh = false): readonly string[] => {
    if (roots === undefined) {
      roots = lister(cwd);
      lastRefreshAt = Date.now();
      return roots;
    }
    const now = Date.now();
    const due = now - lastRefreshAt >= debounceMs;
    if (due || forceRefresh) {
      if (due) {
        lastRefreshAt = now;
        // Replace the cache wholesale so roots git no longer lists are evicted.
        roots = lister(cwd);
      }
    }
    return roots;
  };
}
