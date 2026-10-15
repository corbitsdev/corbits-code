import type { SpawnOptions } from "node:child_process";

// One process-group-kill policy for every spawned tool subprocess: the child
// is spawned detached so it becomes a group leader, and the kill reaches the
// whole group (open-ended walks cannot outlive their parent on POSIX).

/** The child subset a tree kill needs; ChildProcess satisfies it. */
export interface TreeChild {
  pid?: number | undefined;
  kill: (signal?: NodeJS.Signals) => unknown;
}

/**
 * Signals the whole process group. With detached:true the spawned child is the
 * group leader, so grandchildren (build watchers, test runners' workers) die too.
 */
export function killProcessTree(child: TreeChild): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      child.kill("SIGKILL");
    } else {
      // Negative PID signals the whole process group.
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }
}

/** Spawn options making the child a process-group leader (POSIX only). */
export function processGroupLeaderSpawnOptions(): Pick<
  SpawnOptions,
  "detached"
> {
  return { detached: process.platform !== "win32" };
}
