/**
 * Stored worker lifecycle for SubAgentSessionStore.
 *
 * `status` / `lifecycleStatus` on snapshots are projections of this union.
 * `not_found` is a query result only and is never stored.
 */

export type WorkerLifecycle =
  | { state: "pending_init" }
  | { state: "running" }
  | { state: "completed"; report: string }
  | { state: "failed"; error: string }
  | { state: "interrupted"; report?: string }
  | { state: "cancelled"; report?: string; error?: string }
  | { state: "shutdown"; report?: string; error?: string };

export type StripStatus = "running" | "done" | "failed" | "cancelled";

export type VerbLifecycleStatus =
  "pending_init" | "running" | "interrupted" | "completed" | "shutdown";

/** TUI / Agents-strip status. Interrupted lingers as running. */
export function projectStripStatus(lifecycle: WorkerLifecycle): StripStatus {
  switch (lifecycle.state) {
    case "pending_init":
    case "running":
    case "interrupted":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
    case "shutdown":
      return "cancelled";
  }
}

/**
 * Verb JSON (close/resume/interrupt). Does not leak `cancelled` or `failed`:
 * cancelled → interrupted, failed → shutdown.
 */
export function projectLifecycleStatus(lifecycle: WorkerLifecycle): VerbLifecycleStatus {
  switch (lifecycle.state) {
    case "pending_init":
      return "pending_init";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "interrupted":
    case "cancelled":
      return "interrupted";
    case "failed":
    case "shutdown":
      return "shutdown";
  }
}

/** pending_init / running / interrupted — strip still shows running. */
export function isLiveStrip(lifecycle: WorkerLifecycle): boolean {
  return projectStripStatus(lifecycle) === "running";
}

/** Agent already disposed — close_agent must not wait for a handle. */
export function isAlreadyClosed(lifecycle: WorkerLifecycle): boolean {
  return lifecycle.state === "failed" || lifecycle.state === "shutdown";
}

export function isResumableLifecycle(
  retained: boolean | undefined,
  lifecycle: WorkerLifecycle,
): boolean {
  return (
    retained === true && (lifecycle.state === "completed" || lifecycle.state === "interrupted")
  );
}

export type WaitJSONStatus =
  | "running"
  | "queued"
  | "done"
  | "failed"
  | "interrupted"
  | "awaiting_director";

/** Wait statuses that must not collect, freeze, or tombstone as a payload. */
export function isLiveWaitStatus(status: WaitJSONStatus): boolean {
  return status === "running" || status === "queued" || status === "awaiting_director";
}

/**
 * Wait JSON projection of stored lifecycle. Operator cancel (`cancelled`) is
 * wait-running while a run/followup is still in flight so the first collect
 * can still attach salvage. A followup that has been queued (`inFlight`) must
 * not collect the prior `completed` / `interrupted` stamp — resume_agent
 * flips the session to running on the next mutate, but `runInFlight` is set
 * first. `interrupted` and `shutdown` are immediately terminal once the run
 * has settled. Never leaks `cancelled` into wait JSON.
 */
export function projectWaitStatus(lifecycle: WorkerLifecycle, inFlight: boolean): WaitJSONStatus {
  if (
    inFlight &&
    (lifecycle.state === "cancelled" ||
      lifecycle.state === "completed" ||
      lifecycle.state === "interrupted")
  ) {
    return "running";
  }
  switch (lifecycle.state) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "interrupted":
    case "cancelled":
    case "shutdown":
      return "interrupted";
    case "pending_init":
    case "running":
      return "running";
  }
}
