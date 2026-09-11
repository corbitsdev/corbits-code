import { getActiveRun } from "./active-run.js";
import type { RunState } from "./state.js";

/** Cadence for mid-run `running` heartbeats that keep session mtime fresh. */
export const RUN_HEARTBEAT_INTERVAL_MS = 5 * 60_000;

/** Two missed heartbeats: a `running` record older than this is stale. */
export const RUN_STALE_THRESHOLD_MS = 2 * RUN_HEARTBEAT_INTERVAL_MS;

/** Same window as the stale threshold: in-flight atomicWrite temps stay. */
export const RUN_TMP_SWEEP_AGE_MS = RUN_STALE_THRESHOLD_MS;

export function isStaleRunningMtime(
  mtimeMs: number,
  nowMs: number,
  staleThresholdMs: number = RUN_STALE_THRESHOLD_MS,
): boolean {
  return nowMs - mtimeMs > staleThresholdMs;
}

/** Age a parseable stale `running` record to `interrupted` (resumable). */
export function ageStaleRunningState(
  state: RunState,
  mtimeMs: number,
  opts: {
    nowMs?: number;
    staleThresholdMs?: number;
    sessionId?: string;
  } = {},
): RunState {
  if (state.status !== "running") return state;
  const nowMs = opts.nowMs ?? Date.now();
  const staleThresholdMs = opts.staleThresholdMs ?? RUN_STALE_THRESHOLD_MS;
  if (!isStaleRunningMtime(mtimeMs, nowMs, staleThresholdMs)) return state;
  // A live process owns this session — heartbeat/write path still has it.
  const active = getActiveRun();
  if (
    opts.sessionId !== undefined &&
    active !== null &&
    active.sessionId === opts.sessionId
  ) {
    return state;
  }
  return {
    ...state,
    status: "interrupted",
    finishedAt: state.finishedAt ?? mtimeMs,
  };
}

/**
 * Periodic running snapshot writer. `unref` so the timer cannot keep a
 * process alive after the run ends; callers must stop it on terminal paths
 * so no post-terminal writes fire.
 */
export function startRunHeartbeat(args: {
  intervalMs?: number;
  shouldTick: () => boolean;
  tick: () => void | Promise<void>;
}): () => void {
  const intervalMs = args.intervalMs ?? RUN_HEARTBEAT_INTERVAL_MS;
  const timer = setInterval(() => {
    if (!args.shouldTick()) return;
    void Promise.resolve(args.tick()).catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
