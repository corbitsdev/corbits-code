#!/usr/bin/env bun
// Parallel test runner with a stall watchdog.
//
// `bun test --parallel` intermittently livelocks on Bun 1.4.x: a worker
// spins at 100% CPU while a git child it spawned is left as a zombie, and
// the suite produces no further output (upstream Bun issue #36235, still
// open as of 1.4.2). bun test has no run-level timeout, so this wrapper
// runs the suite in its own process group, watches for an output stall
// well beyond any healthy run's silence, kills the group, and retries.
// A child that exits on its own (pass or fail) is never retried.
//
// Usage: bun scripts/test-parallel.ts [workers]   (default 4)

export const DEFAULT_WORKERS = 4;
export const DEFAULT_STALL_MS = 90_000;
export const DEFAULT_ATTEMPTS = 3;
// SIGKILL a group that ignores SIGTERM this long.
const KILL_GRACE_MS = 5_000;

export interface WatchdogOptions {
  // Arguments after the bun binary, e.g. ["test", "./src", "--parallel", "4"].
  args: string[];
  // Bun binary to spawn. Defaults to the running binary.
  command?: string;
  stallMs?: number;
  attempts?: number;
  onOutput?: (chunk: Uint8Array, stream: "stdout" | "stderr") => void;
  // Report a stall so the caller can log the retry. Defaults to stderr.
  onStall?: (attempt: number, maxAttempts: number) => void;
}

export interface WatchdogResult {
  exitCode: number;
  stalled: boolean;
  attempts: number;
}

const STALL_CODE = -1;

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateGroup(pid: number): Promise<void> {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // group already gone
  }
}

interface AttemptOutcome {
  exitCode: number;
  stalled: boolean;
}

async function runAttempt(
  command: string,
  args: string[],
  stallMs: number,
  onOutput: WatchdogOptions["onOutput"],
): Promise<AttemptOutcome> {
  const child = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    // Own process group so a stall kills bun test, its workers, and any
    // grandchild (e.g. git) together.
    detached: true,
  });

  let lastOutput = Date.now();
  let stalled = false;
  let exited = false;

  const touch = (chunk: Uint8Array, stream: "stdout" | "stderr") => {
    lastOutput = Date.now();
    onOutput?.(chunk, stream);
  };
  const pumpStream = async (
    stream: typeof child.stdout,
    kind: "stdout" | "stderr",
  ): Promise<void> => {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      touch(value, kind);
    }
  };
  const pumps = [
    pumpStream(child.stdout, "stdout"),
    pumpStream(child.stderr, "stderr"),
  ];

  const tickMs = Math.max(100, Math.min(5_000, stallMs));
  const watchdog = setInterval(() => {
    if (exited) return;
    // Re-check liveness: the child may have exited between output and now.
    if (!groupAlive(child.pid)) {
      exited = true;
      return;
    }
    if (Date.now() - lastOutput > stallMs) {
      stalled = true;
      clearInterval(watchdog);
      void terminateGroup(child.pid);
    }
  }, tickMs);

  const raw = await child.exited;
  exited = true;
  clearInterval(watchdog);
  await Promise.allSettled(pumps);
  // null means killed by a signal; the stalled flag says who did it.
  const exitCode = raw === null ? (stalled ? STALL_CODE : 1) : raw;
  return { exitCode, stalled };
}

export async function runWithWatchdog(
  opts: WatchdogOptions,
): Promise<WatchdogResult> {
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  const maxAttempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const command = opts.command ?? process.execPath;
  const reportStall =
    opts.onStall ??
    ((attempt, max) =>
      console.error(
        `[test:parallel] no output for ${Math.round(stallMs / 1000)}s — ` +
          `killing stalled run (attempt ${attempt}/${max}); ` +
          `Bun --parallel livelock, see Bun issue #36235`,
      ));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { exitCode, stalled } = await runAttempt(
      command,
      opts.args,
      stallMs,
      opts.onOutput,
    );
    if (!stalled) {
      return { exitCode, stalled: false, attempts: attempt };
    }
    if (attempt < maxAttempts) reportStall(attempt, maxAttempts);
  }
  return { exitCode: 1, stalled: true, attempts: maxAttempts };
}

if (import.meta.main) {
  const arg = process.argv[2];
  const workers = arg === undefined ? DEFAULT_WORKERS : Number(arg);
  if (!Number.isInteger(workers) || workers < 1 || workers > 16) {
    console.error("usage: bun scripts/test-parallel.ts [workers 1-16]");
    process.exit(2);
  }
  const result = await runWithWatchdog({
    args: [
      "test",
      "./src",
      "./tests",
      "./evals",
      "./scripts",
      "--randomize",
      "--seed",
      "424242",
      "--parallel",
      String(workers),
    ],
    onOutput: (chunk, stream) => {
      (stream === "stdout" ? process.stdout : process.stderr).write(chunk);
    },
  });
  process.exit(result.exitCode);
}
