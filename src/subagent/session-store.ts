// In-memory registry of sub-agent sessions for TUI inspection.
//
// Parent chat must not receive full child text deltas (that interleaves worker
// prose into the parent turn). Progress stays on the light onProgress channel;
// this store is the dedicated child record the enter-session UI reads.

import type { ReactorEmittedEvent } from "@intx/inference";
import { getLogger } from "@intx/log";
import { LOG_NAMESPACE_ROOT } from "../branding.js";
import { DEFAULT_CLOSE_DEADLINE_MS } from "./dispose.js";
import {
  isAlreadyClosed,
  isLiveStrip,
  isResumableLifecycle,
  projectLifecycleStatus,
  projectStripStatus,
  type WorkerLifecycle,
} from "./lifecycle.js";
import type { ForcedStopReason } from "./stop-policy.js";
import { toolCallPreview } from "./tool-preview.js";

const log = getLogger([LOG_NAMESPACE_ROOT, "subagent", "session-store"]);

export type SubAgentSessionStatus = "running" | "done" | "failed" | "cancelled";

/**
 * Lifecycle status surfaced to the parent for the reusable-session verbs
 * (close_agent / resume_agent). Snapshot `lifecycleStatus` is a projection of
 * stored `WorkerLifecycle` and never leaks `cancelled` or `failed`
 * (cancelled → interrupted, failed → shutdown). `not_found` is a query result
 * only — never stored.
 */
export type AgentLifecycleStatus =
  "pending_init" | "running" | "interrupted" | "completed" | "shutdown" | "not_found";

export type { WorkerLifecycle };

// Compact transcript entries suitable for TUI render without depending on the
// TUI ContentBlock type (keeps subagent free of a reverse dependency on tui/).
export type SubAgentTranscriptEntry =
  | { kind: "text"; content: string }
  | { kind: "thinking"; content: string }
  | { kind: "tool"; callId: string; name: string; arguments: string }
  | { kind: "tool_result"; callId: string; name: string; content: string; isError: boolean }
  | { kind: "report"; content: string };

export interface OutstandingToolCall {
  callId: string;
  name: string;
  startedAt: number;
  /**
   * Bounded one-line subject of the call (command, path, pattern…), or null
   * when the args have nothing useful to show. Derived from the same raw
   * arguments the transcript stores so the lane and the body cannot disagree
   * about what is running (CL-5765).
   */
  preview: string | null;
}

export interface SubAgentSession {
  id: string;
  description: string;
  agentId: string;
  brief: string;
  /** Projection of `lifecycle` for TUI / Agents strip. */
  status: SubAgentSessionStatus;
  /** Stored source of truth. Snapshot copies it; do not mutate independently. */
  lifecycle: WorkerLifecycle;
  toolNames: string[];
  // Name, preview, and start clock of the OLDEST outstanding call — the one
  // that explains the longest silence. All three are derived from
  // `outstandingTools`; never assign them directly. Null when nothing is in
  // flight.
  //
  // A worker inside one long tool emits no events for the whole execution, so
  // silence alone cannot tell "wedged" from "running a ten-minute test suite".
  // The start clock is the fact that separates them. The preview is what lets
  // an operator tell six shell commands apart on a fleet board.
  currentToolName: string | null;
  currentToolPreview: string | null;
  currentToolStartedAt: number | null;
  // Calls the reactor has started and not yet reported a result for. The
  // reactor runs parallel calls concurrently, so this cannot collapse to one
  // scalar: a fast grep finishing beside a ten-minute shell command would
  // otherwise retire the shell command's clock and the lane would read as
  // stalled while working perfectly.
  outstandingTools: OutstandingToolCall[];
  entries: SubAgentTranscriptEntry[];
  startedAt: number;
  // Clock of the last event this session recorded (a stream token, a tool
  // start/end, a status change). Distinct from startedAt so the strip can
  // tell a worker mid-turn from one that has gone silent.
  lastActivityAt: number;
  // Clock the live turn ended (complete/fail/cancel, and interrupt while TUI
  // status may still be "running"). Drives chrome linger; leftover tools may
  // still be outstanding after this stamp.
  finishedAt?: number;
  report?: string;
  error?: string;
  /**
   * Typed ForcedStopReason from runSubAgent, or `cancelled — <reason>` on
   * cancel(). Absent on clean completes. Never parsed from report prose.
   */
  stopReason?: string;
  // Session id of the orchestrator that dispatched this worker, when this is
  // a nested (one-hop) dispatch. Undefined for top-level sessions started
  // directly from the primary session's spawn_agent tool.
  parentSessionId?: string;
  /**
   * Projection of `lifecycle` for close/resume/interrupt JSON. Maps cancelled →
   * interrupted and failed → shutdown so those verbs do not leak new enum values.
   */
  lifecycleStatus: AgentLifecycleStatus;
  // True when this session's agent is meant to survive a clean completion
  // (spawn_agent opts in). An open retained session ("completed" or
  // "interrupted") is governed by its own retention cap (`maxRetained`),
  // separate from `maxCompleted` (the TUI display cap) — see pruneRetained.
  // Once close_agent runs, this flips back to false and the session is a
  // normal finished record subject to `maxCompleted` like any other.
  retained?: boolean;
}

export interface StartSessionInput {
  description: string;
  agentId: string;
  brief: string;
  // Optional external id (e.g. parent tool callId) so the Agents strip can
  // correlate progress with the session. Generated when omitted.
  id?: string;
  // Set when this session is a nested dispatch spawned by an orchestrator
  // sub-agent, so the strip can render it indented under its parent.
  parentSessionId?: string;
  // CL-6943: opt in to end-of-turn retention (spawn_agent sets this).
  retained?: boolean;
}

export interface SubAgentSessionStoreOptions {
  // Cap on completed/failed sessions retained after finish. Running sessions
  // are never pruned by this bound. Does NOT govern open retained sessions
  // ("completed"/"interrupted" with retained:true) — see maxRetained.
  maxCompleted?: number;
  // CL-7007: cap on open retained sessions (spawn_agent workers a caller may
  // still resume_agent). Sized for fan-out (dozens of
  // concurrent workers), independent of maxCompleted's TUI display cap.
  // Least-recently-used is evicted first; a "running" session is never
  // evicted regardless of this bound. Non-finite/undefined values (and a
  // JSON round-trip that turned a configured Infinity into null) fall back
  // to the default rather than silently becoming 0.
  maxRetained?: number;
  // Cap on transcript entries per session (oldest dropped).
  maxEntries?: number;
  // Cap on characters per text/thinking/result entry.
  maxEntryChars?: number;
  now?: () => number;
  createId?: () => string;
}

export interface SubAgentSessionStore {
  list(): readonly SubAgentSession[];
  get(id: string): SubAgentSession | undefined;
  /**
   * Verb lifecycle of a session dropped by pruneRetained, if a tombstone remains.
   * `get` does not surface these — they exist so wait/resume can recover a
   * terminal status instead of treating the id as never-seen.
   */
  evictedLifecycle(id: string): AgentLifecycleStatus | undefined;
  // Running + recent completed, newest first — surface for the Agents strip.
  listForStrip(): readonly SubAgentSession[];
  start(input: StartSessionInput): SubAgentSession;
  appendEvent(id: string, event: ReactorEmittedEvent): void;
  // `agentRetained` (CL-7001) must mirror run.ts's own turnSucceeded gate —
  // true only when the caller actually skipped teardown for this turn. A
  // deadline/cancel salvage resolves the same promise agent-fleet routes
  // here but always disposes its agent first, so omitting/false-ing this
  // keeps a disposed session from ever reporting as resumable.
  complete(
    id: string,
    report: string,
    opts?: { agentRetained?: boolean; stopReason?: ForcedStopReason },
  ): void;
  fail(id: string, error: string): void;
  // Register the live abort handle for a running session so cancel() can stop
  // the child reactor (agent.close), not only flip status.
  registerCancel(id: string, abort: () => void): void;
  // Abort a running session and mark it cancelled. Returns true when a running
  // session was cancelled; false if missing or already terminal.
  cancel(id: string, reason?: string): boolean;
  // Cancel every running session. Returns the ids that transitioned.
  cancelAll(reason?: string): string[];
  // CL-6943: flips a "pending_init" session to "running" once its agent
  // object actually exists. No-op on an unknown id or one already past init.
  markRunning(id: string): void;
  // Registers the bounded close function close_agent will call later. Only
  // one is kept per id (a later call replaces an earlier one, matching
  // start()'s replace-on-reuse behavior for cancelHandles).
  registerClose(id: string, close: (deadlineMs?: number) => Promise<void>): void;
  // Runs the registered close for one session (bounded by deadlineMs) and
  // marks it "shutdown" — terminal, and no longer exempt from pruneCompleted.
  // Idempotent: closing an already-shutdown session is a no-op. Resolves
  // "not_found" for an unknown id without throwing (callers need the status,
  // not an exception, to report per-target results across a descendant walk).
  closeOne(id: string, deadlineMs: number): Promise<AgentLifecycleStatus>;
  // Transitions a retained, still-open ("completed" or "interrupted") session
  // back to "running", starts the next turn through the registered followup
  // handle, and returns immediately. wait_agents collects the reply. Fails
  // closed on anything else — a "shutdown" session is gone for good
  // (close_agent is permanent), a still-running turn is concurrent, and
  // "pending_init"/"not_found" have nothing to resume.
  // CL-7007: a session dropped by pruneRetained still reports its terminal
  // lifecycleStatus plus `hint` pointing at read_agent_trace — never a bare
  // "not_found" that reads like a bad id.
  resumeOne(
    id: string,
    message: string,
    opts?: {
      onStart?: () => void;
      onReply?: (reply: string) => void;
      onFail?: (error: unknown) => void;
    },
  ): { ok: true; status: "running" } | { ok: false; status: AgentLifecycleStatus; hint?: string };
  // CL-6997: registers the per-session interrupt/followup handles run.ts
  // hands back via onAgentReady. Distinct maps from registerClose/closeOne
  // above (interrupt must never route through close's codepath).
  registerInterrupt(id: string, interrupt: () => void): void;
  registerFollowup(id: string, followup: (message: string) => Promise<string>): void;
  // Fires the registered interrupt handle and flips lifecycleStatus to
  // "interrupted" synchronously — the caller does not wait for the aborted
  // run's promise to settle. Fails closed on anything not currently running
  // or with no interrupt handle registered (e.g. a session past init).
  interruptOne(id: string): { ok: true } | { ok: false; status: AgentLifecycleStatus };
  registerDeliver(id: string, deliver: (message: string) => void): void;
  sendInputOne(
    id: string,
    message: string,
    opts?: { interrupt?: boolean; onFollowupReply?: (reply: string) => void },
  ): { ok: true; status: AgentLifecycleStatus } | { ok: false; status: AgentLifecycleStatus };
  /**
   * One pending ask_director per session. `sendInputOne` (soft) resolves it;
   * interrupt/settle/close cancel it. Wait JSON projects this, not lifecycle.
   */
  registerAsk(
    id: string,
    ask: {
      question: string;
      questionId: string;
      resolve: (answer: string) => void;
      reject: (reason: unknown) => void;
    },
  ): boolean;
  resolveAsk(id: string, answer: string): boolean;
  cancelAsk(id: string, reason?: string): boolean;
  hasPendingAsk(id: string): boolean;
  peekAsk(id: string): { question: string; questionId: string } | undefined;
  /**
   * Refcount so wait mailboxes can pin an uncollected result. pruneCompleted
   * will not delete a session while its pin count is greater than zero.
   */
  pin(id: string): void;
  unpin(id: string): void;
  /**
   * Attach a salvage report to cancelled/interrupted/shutdown without changing
   * `state`. Never overwrites an existing report. If the session is still
   * pending_init/running (interrupt result with no prior interrupt_agent),
   * flip to interrupted rather than completed. Clears the in-flight-run bit
   * and notifies waiters.
   */
  attachReport(id: string, report: string): void;
  /** True while a run or followup has not settled. */
  isRunInFlight(id: string): boolean;
  /**
   * Catch-path settle: clear the in-flight bit without changing lifecycle so
   * operator cancel becomes wait-terminal when there is no salvage body.
   */
  settleRun(id: string): void;
  /** Wake subscribers without mutating a session (mailbox overlay writers). */
  wake(): void;
  subscribe(listener: () => void): () => void;
  clear(): void;
}

export const DEFAULT_CANCEL_REASON = "Cancelled by operator";

const DEFAULT_MAX_COMPLETED = 20;
// CL-7007: sized for fan-out dispatch (dozens of spawn_agent workers), not a
// sidebar list — see maxRetained doc above.
const DEFAULT_MAX_RETAINED = 50;
const DEFAULT_MAX_ENTRIES = 400;
/** Cap on characters per transcript entry / send_input message body. */
export const DEFAULT_MAX_ENTRY_CHARS = 24_000;

const EVICTED_RETENTION_HINT =
  "Session evicted to bound retained-session memory; recover full detail via read_agent_trace(agent_id).";

// Bound on tombstones kept for evicted sessions, so an unbounded stream of
// short-lived retained workers cannot grow this map forever either.
const MAX_EVICTED_TOMBSTONES = 500;

/** Resolves a configured cap, guarding against non-finite values (including
 * a JSON round-trip that turned a configured `Infinity` into `null`) so the
 * cap can never silently collapse to `0`/`NaN`. */
function resolveCap(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

/** Terminal record for a session dropped from the store by retention eviction. */
interface EvictedRecord {
  lifecycleStatus: AgentLifecycleStatus;
  hint: string;
}

/** In-map record: `status` / `lifecycleStatus` exist only on snapshots. */
type StoredSession = Omit<SubAgentSession, "status" | "lifecycleStatus">;

let nextId = 0;
function defaultCreateId(): string {
  nextId += 1;
  return `subagent-${nextId}`;
}

/**
 * The one place the displayed triple is produced, so a name / preview can never
 * be shown beside another call's clock. Called after every change to
 * `outstandingTools`.
 */
function syncCurrentTool(session: StoredSession): void {
  let oldest: OutstandingToolCall | undefined;
  for (const call of session.outstandingTools) {
    if (oldest === undefined || call.startedAt < oldest.startedAt) oldest = call;
  }
  session.currentToolName = oldest?.name ?? null;
  session.currentToolPreview = oldest?.preview ?? null;
  session.currentToolStartedAt = oldest?.startedAt ?? null;
}

/**
 * `restartClock` marks the execution boundary: argument streaming already
 * registered the call, and the figure worth showing is time spent running it.
 * `rawArgs`, when known, refreshes the lane preview from the same payload the
 * transcript stores.
 */
function beginToolCall(
  session: StoredSession,
  callId: string,
  name: string,
  nowMs: number,
  restartClock = false,
  rawArgs?: string,
): void {
  const existing = session.outstandingTools.find((c) => c.callId === callId);
  const preview =
    rawArgs !== undefined ? toolCallPreview(name, rawArgs) : (existing?.preview ?? null);
  if (existing !== undefined) {
    existing.name = name;
    if (restartClock) existing.startedAt = nowMs;
    if (rawArgs !== undefined) existing.preview = preview;
  } else {
    session.outstandingTools.push({
      callId,
      name,
      startedAt: nowMs,
      preview,
    });
  }
  syncCurrentTool(session);
}

/** Refresh the outstanding call's preview once more of its arguments stream in. */
function refreshToolPreview(
  session: StoredSession,
  callId: string,
  name: string,
  rawArgs: string,
): void {
  const existing = session.outstandingTools.find((c) => c.callId === callId);
  if (existing === undefined) return;
  existing.preview = toolCallPreview(name, rawArgs);
  syncCurrentTool(session);
}

/**
 * Retires exactly the call that finished. A result carrying an id we never saw
 * start retires nothing, rather than silently clearing a live sibling's clock.
 */
function endToolCall(session: StoredSession, callId: string): void {
  const index = session.outstandingTools.findIndex((c) => c.callId === callId);
  if (index === -1) return;
  session.outstandingTools.splice(index, 1);
  syncCurrentTool(session);
}

function clearToolCalls(session: StoredSession): void {
  session.outstandingTools.length = 0;
  syncCurrentTool(session);
}

function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max);
}

function appendCapped(prev: string, next: string, max: number): string {
  if (prev.length >= max) return prev;
  if (prev.length + next.length <= max) return prev + next;
  return prev + next.slice(0, max - prev.length);
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createSubAgentSessionStore(
  options: SubAgentSessionStoreOptions = {},
): SubAgentSessionStore {
  const maxCompleted = resolveCap(options.maxCompleted, DEFAULT_MAX_COMPLETED);
  const maxRetained = resolveCap(options.maxRetained, DEFAULT_MAX_RETAINED);
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxEntryChars = options.maxEntryChars ?? DEFAULT_MAX_ENTRY_CHARS;
  const now = options.now ?? (() => Date.now());
  const createId = options.createId ?? defaultCreateId;

  // Insertion order: older first. list() returns a snapshot in that order.
  const sessions = new Map<string, StoredSession>();
  // Pin refcount: wait mailboxes hold a pin until they collect the result.
  const pinCounts = new Map<string, number>();
  // Live run/followup: operator cancel is wait-terminal only after this clears.
  const runInFlight = new Set<string>();
  // Live abort hooks keyed by session id. Cleared on terminal transition.
  const cancelHandles = new Map<string, () => void>();
  // CL-6943: bounded close functions keyed by session id, for close_agent.
  // Distinct from cancelHandles (a synchronous abort() signal) because
  // closing must be awaitable and bounded by a deadline.
  const closeHandles = new Map<string, (deadlineMs?: number) => Promise<void>>();
  // CL-6997: interrupt/followup handles, kept separate from closeHandles so
  // an interrupt can never accidentally resolve to the close codepath.
  const interruptHandles = new Map<string, () => void>();
  const followupHandles = new Map<string, (message: string) => Promise<string>>();
  const deliverHandles = new Map<string, (message: string) => void>();
  const pendingAsks = new Map<
    string,
    {
      question: string;
      questionId: string;
      resolve: (answer: string) => void;
      reject: (reason: unknown) => void;
    }
  >();
  const listeners = new Set<() => void>();
  // CL-7007: tombstones for sessions dropped by pruneRetained, keyed by id,
  // insertion-ordered (Map preserves it) so the oldest can be dropped first
  // once MAX_EVICTED_TOMBSTONES is exceeded. Lets resume_agent
  // report an actionable terminal status instead of a bare "not_found" for a
  // session evicted purely to bound retention memory.
  const evicted = new Map<string, EvictedRecord>();

  const recordEviction = (session: StoredSession): void => {
    evicted.set(session.id, {
      lifecycleStatus: projectLifecycleStatus(session.lifecycle),
      hint: EVICTED_RETENTION_HINT,
    });
    if (evicted.size > MAX_EVICTED_TOMBSTONES) {
      const oldest = evicted.keys().next().value;
      if (oldest !== undefined) evicted.delete(oldest);
    }
  };

  // Per-session revision counters, bumped on every mutation. Notify fires on
  // every streamed child token, so list()/get()/listForStrip() would otherwise
  // deep-clone every session's full entry buffer on every token even though
  // only one session changed. Caching a clone keyed by the revision it was
  // taken at lets unrelated sessions reuse their last snapshot instead.
  const revisions = new Map<string, number>();
  const snapshotCache = new Map<string, { revision: number; snapshot: SubAgentSession }>();

  const bumpRevision = (id: string): void => {
    revisions.set(id, (revisions.get(id) ?? 0) + 1);
  };

  const forgetRevision = (id: string): void => {
    revisions.delete(id);
    snapshotCache.delete(id);
  };

  const snapshotOf = (session: StoredSession): SubAgentSession => {
    const revision = revisions.get(session.id) ?? 0;
    const cached = snapshotCache.get(session.id);
    if (cached !== undefined && cached.revision === revision) return cached.snapshot;
    const snapshot = cloneSession(session);
    snapshotCache.set(session.id, { revision, snapshot });
    return snapshot;
  };

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const isSessionUnder = (id: string, ancestorId: string): boolean => {
    const seen = new Set<string>();
    let current = sessions.get(id);
    while (current !== undefined) {
      if (seen.has(current.id)) return false;
      seen.add(current.id);
      if (current.parentSessionId === ancestorId) return true;
      if (current.parentSessionId === undefined) return false;
      current = sessions.get(current.parentSessionId);
    }
    return false;
  };

  const cancelAskInternal = (id: string, reason: string): boolean => {
    const pending = pendingAsks.get(id);
    if (pending === undefined) return false;
    pendingAsks.delete(id);
    try {
      pending.reject(new Error(reason));
    } catch {
      // Reject must not throw into settle/interrupt paths.
    }
    notify();
    return true;
  };

  const cancelDescendantAsks = (ancestorId: string, reason: string): void => {
    for (const session of sessions.values()) {
      if (session.id === ancestorId) continue;
      if (isSessionUnder(session.id, ancestorId)) cancelAskInternal(session.id, reason);
    }
  };

  const settleCancelsAsks = (id: string, reason: string): void => {
    cancelAskInternal(id, reason);
    cancelDescendantAsks(id, reason);
  };

  const markCancelled = (session: StoredSession, reason: string): void => {
    session.lifecycle = { state: "cancelled", error: reason };
    session.retained = false;
    session.finishedAt = now();
    session.lastActivityAt = now();
    clearToolCalls(session);
    session.error = reason;
    session.stopReason = reason === DEFAULT_CANCEL_REASON ? "cancelled" : `cancelled — ${reason}`;
    pushEntry(session, {
      kind: "report",
      content: capText(`Cancelled: ${reason}`, maxEntryChars),
    });
    cancelHandles.delete(session.id);
    // closeHandles are owned by releaseHandles / closeOne — dropping them
    // here would skip teardown for a retained session that is mid-turn.
    bumpRevision(session.id);
    pruneCompleted();
  };

  const cancelSession = (id: string, reason: string): boolean => {
    settleCancelsAsks(id, reason);
    const session = sessions.get(id);
    if (session === undefined || !isLiveStrip(session.lifecycle)) return false;
    const abort = cancelHandles.get(id);
    // Flip status first so concurrent complete/fail see a non-running session,
    // then fire the abort handle (which may re-enter via signal listeners).
    markCancelled(session, reason);
    notify();
    if (abort !== undefined) {
      try {
        abort();
      } catch {
        // Abort hooks must not throw into the UI / tool path.
      }
    }
    return true;
  };

  const pushEntry = (session: StoredSession, entry: SubAgentTranscriptEntry): void => {
    session.entries.push(entry);
    if (session.entries.length > maxEntries) {
      session.entries.splice(0, session.entries.length - maxEntries);
    }
  };

  // CL-7001: releases any resources this store still holds for `id` — the
  // registered close handle (invoked best-effort, fire-and-forget, so a
  // wedged descendant cannot stall the caller that triggered eviction) and
  // the cancel handle. Called whenever a session record is dropped, so a
  // retained-but-idle session's real agent is never simply forgotten about.
  const releaseHandles = (id: string): void => {
    const close = closeHandles.get(id);
    if (close !== undefined) {
      closeHandles.delete(id);
      void close(DEFAULT_CLOSE_DEADLINE_MS).catch((err: unknown) => {
        log.warn("session close during handle release failed: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    cancelHandles.delete(id);
    interruptHandles.delete(id);
    followupHandles.delete(id);
    deliverHandles.delete(id);
  };

  // An open retained session (spawn_agent's reusable-session contract:
  // retained:true and still addressable — "completed" or "interrupted") is
  // governed by pruneRetained's own cap below, not this one.
  const isOpenRetained = (s: StoredSession): boolean =>
    s.retained === true &&
    (s.lifecycle.state === "completed" || s.lifecycle.state === "interrupted");

  const isPinned = (id: string): boolean => (pinCounts.get(id) ?? 0) > 0;

  const isPrunableCompleted = (s: StoredSession): boolean =>
    !isLiveStrip(s.lifecycle) && !isOpenRetained(s) && !isPinned(s.id);

  // CL-7001/CL-7007: `maxCompleted` bounds every ordinary finished session —
  // one that was never retained, or a retained one already closed via
  // close_agent (retained flips back to false there). It is a TUI display
  // cap and was never sized to also be the retention policy for reusable
  // sessions; open retained sessions are excluded here and bounded instead
  // by pruneRetained. A session that was resumed and is actively running
  // again (lifecycle state "running") is still excluded: it has a live
  // caller, not an idle leak. Pinned ids (uncollected wait results) are
  // also excluded so maxCompleted cannot delete them.
  const pruneCompleted = (): void => {
    if (maxCompleted <= 0) {
      for (const [id, s] of sessions) {
        if (isPrunableCompleted(s)) {
          releaseHandles(id);
          sessions.delete(id);
          forgetRevision(id);
        }
      }
      return;
    }
    const finished = [...sessions.values()]
      .filter(isPrunableCompleted)
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    const excess = finished.length - maxCompleted;
    if (excess <= 0) return;
    for (let i = 0; i < excess; i++) {
      const drop = finished[i];
      if (drop !== undefined) {
        releaseHandles(drop.id);
        sessions.delete(drop.id);
        forgetRevision(drop.id);
      }
    }
  };

  // CL-7007: bounds open retained sessions (dozens-of-workers fan-out), the
  // resource-safety bound CL-7002 removed by mistake when it folded retained
  // sessions into pruneCompleted's TUI cap. Evicts least-recently-used first
  // (by lastActivityAt); a session actively running again is never a
  // candidate (excluded by isOpenRetained requiring "completed"/
  // "interrupted"). Handles are released exactly like pruneCompleted's
  // eviction — sidecars, reactor, and the lock entry are not simply
  // forgotten — and a tombstone is kept so resume_agent can
  // still report an actionable status afterward instead of "not_found".
  const pruneRetained = (): void => {
    const openRetained = [...sessions.values()]
      .filter((s) => isOpenRetained(s) && !isPinned(s.id))
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    const excess = openRetained.length - maxRetained;
    if (excess <= 0) return;
    for (let i = 0; i < excess; i++) {
      const drop = openRetained[i];
      if (drop !== undefined) {
        releaseHandles(drop.id);
        recordEviction(drop);
        sessions.delete(drop.id);
        forgetRevision(drop.id);
      }
    }
  };

  // CL-7001: resolves once `id` either gets a close handle registered, goes
  // shutdown, disappears, or `deadlineMs` elapses (whichever first) — the
  // wait closeOne uses for a close_agent call that raced agent setup.
  const waitForCloseHandle = (
    id: string,
    deadlineMs: number,
  ): Promise<((deadlineMs?: number) => Promise<void>) | undefined> => {
    return new Promise((resolve) => {
      let settled = false;
      const listener = (): void => check();
      const finish = (value: ((deadlineMs?: number) => Promise<void>) | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(value);
      };
      const check = (): void => {
        const session = sessions.get(id);
        if (session === undefined) {
          finish(undefined);
          return;
        }
        const close = closeHandles.get(id);
        if (close !== undefined) {
          finish(close);
          return;
        }
        if (isAlreadyClosed(session.lifecycle)) finish(undefined);
      };
      listeners.add(listener);
      const timer = setTimeout(() => finish(closeHandles.get(id)), deadlineMs);
      check();
    });
  };

  const mutate = (id: string, fn: (session: StoredSession) => void): void => {
    const session = sessions.get(id);
    if (session === undefined) return;
    fn(session);
    session.lastActivityAt = now();
    bumpRevision(id);
    notify();
  };

  // A follow-up turn takes the lane back over: the worker is live again, so
  // the interrupt's linger stamp must not outlive the new turn. Completion
  // re-stamps through the caller's own mutate; a rejected turn restores the
  // addressable strip state it started from (done, or interrupted linger) so
  // resume_agent can retry. interrupt_agent's stamp on this turn wins over
  // that restore — do not rewrite interrupted back to completed.
  const beginFollowupTurn = (id: string): void => {
    runInFlight.add(id);
    mutate(id, (s) => {
      s.lifecycle = { state: "running" };
      delete s.finishedAt;
    });
  };
  const endFollowupTurn = (id: string, restore: "completed" | "interrupted"): void => {
    mutate(id, (s) => {
      if (s.lifecycle.state !== "running" && s.lifecycle.state !== "pending_init") {
        s.finishedAt = s.finishedAt ?? now();
        return;
      }
      if (restore === "interrupted") {
        s.lifecycle = {
          state: "interrupted",
          ...(s.report !== undefined ? { report: s.report } : {}),
        };
      } else {
        s.lifecycle = { state: "completed", report: s.report ?? "" };
      }
      s.finishedAt = now();
    });
  };
  const queueFollowupTurn = (
    id: string,
    message: string,
    failLifecycle: "completed" | "interrupted",
    opts?: { onReply?: (reply: string) => void; onFail?: (error: unknown) => void },
  ): void => {
    const followup = followupHandles.get(id);
    if (followup === undefined) return;
    beginFollowupTurn(id);
    void followup(message)
      .then((reply) => {
        const still = sessions.get(id);
        if (still === undefined) {
          runInFlight.delete(id);
          return;
        }
        if (
          still.lifecycle.state === "shutdown" ||
          still.lifecycle.state === "cancelled" ||
          still.lifecycle.state === "failed" ||
          still.lifecycle.state === "interrupted"
        ) {
          runInFlight.delete(id);
          return;
        }
        mutate(id, (s) => {
          s.lifecycle = { state: "completed", report: reply };
          s.finishedAt = now();
          s.report = reply;
          pushEntry(s, { kind: "report", content: capText(reply, maxEntryChars) });
        });
        runInFlight.delete(id);
        opts?.onReply?.(reply);
        pruneRetained();
      })
      .catch((err: unknown) => {
        runInFlight.delete(id);
        if (opts?.onFail !== undefined) {
          opts.onFail(err);
        } else {
          endFollowupTurn(id, failLifecycle);
        }
        log.error("followup turn failed for {id}: {error}", {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };

  return {
    list(): readonly SubAgentSession[] {
      return [...sessions.values()].map(snapshotOf);
    },

    get(id: string): SubAgentSession | undefined {
      const session = sessions.get(id);
      return session === undefined ? undefined : snapshotOf(session);
    },

    evictedLifecycle(id: string): AgentLifecycleStatus | undefined {
      return evicted.get(id)?.lifecycleStatus;
    },

    listForStrip(): readonly SubAgentSession[] {
      return [...sessions.values()].map(snapshotOf).sort((a, b) => {
        // Running first, then by startedAt descending.
        if (a.status === "running" && b.status !== "running") return -1;
        if (a.status !== "running" && b.status === "running") return 1;
        return b.startedAt - a.startedAt;
      });
    },

    start(input: StartSessionInput): SubAgentSession {
      const id = input.id !== undefined && input.id.length > 0 ? input.id : createId();
      // Replacing an existing id (e.g. parent reuses a callId) keeps the strip
      // from growing duplicates when a tool call is retried.
      cancelAskInternal(id, "session replaced");
      cancelHandles.delete(id);
      closeHandles.delete(id);
      interruptHandles.delete(id);
      followupHandles.delete(id);
      deliverHandles.delete(id);
      pinCounts.delete(id);
      runInFlight.delete(id);
      forgetRevision(id);
      const session: StoredSession = {
        id,
        description: input.description,
        agentId: input.agentId,
        brief: input.brief,
        lifecycle: { state: "pending_init" },
        toolNames: [],
        currentToolName: null,
        currentToolPreview: null,
        currentToolStartedAt: null,
        outstandingTools: [],
        entries: [],
        startedAt: now(),
        lastActivityAt: now(),
        ...(input.retained === true ? { retained: true } : {}),
        ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
      };
      sessions.set(id, session);
      runInFlight.add(id);
      bumpRevision(id);
      notify();
      return snapshotOf(session);
    },

    appendEvent(id: string, event: ReactorEmittedEvent): void {
      mutate(id, (session) => {
        if (!isLiveStrip(session.lifecycle)) return;
        switch (event.type) {
          case "inference.text.delta": {
            const token = (event.data as { token?: unknown })?.token;
            if (typeof token !== "string" || token.length === 0) return;
            const last = session.entries[session.entries.length - 1];
            if (last?.kind === "text") {
              last.content = appendCapped(last.content, token, maxEntryChars);
            } else {
              pushEntry(session, { kind: "text", content: capText(token, maxEntryChars) });
            }
            return;
          }
          case "inference.thinking.delta": {
            const token = (event.data as { token?: unknown })?.token;
            if (typeof token !== "string" || token.length === 0) return;
            const last = session.entries[session.entries.length - 1];
            if (last?.kind === "thinking") {
              last.content = appendCapped(last.content, token, maxEntryChars);
            } else {
              pushEntry(session, { kind: "thinking", content: capText(token, maxEntryChars) });
            }
            return;
          }
          case "inference.tool_call.start": {
            const data = event.data as { name?: unknown; callId?: unknown };
            const name = typeof data.name === "string" ? data.name : "tool";
            const callId =
              typeof data.callId === "string" ? data.callId : `${name}-${session.entries.length}`;
            beginToolCall(session, callId, name, now());
            if (!session.toolNames.includes(name)) session.toolNames.push(name);
            pushEntry(session, { kind: "tool", callId, name, arguments: "" });
            return;
          }
          case "inference.tool_call.delta": {
            const data = event.data as { argumentFragment?: unknown; callId?: unknown };
            const fragment = data.argumentFragment;
            if (typeof fragment !== "string" || fragment.length === 0) return;
            // Parallel tool calls interleave their deltas; match the owning
            // entry by callId so fragments never attach to a sibling's args.
            const callId = typeof data.callId === "string" ? data.callId : null;
            for (let i = session.entries.length - 1; i >= 0; i--) {
              const entry = session.entries[i];
              if (entry?.kind !== "tool") continue;
              if (callId !== null && entry.callId !== callId) continue;
              entry.arguments = appendCapped(entry.arguments, fragment, maxEntryChars);
              // Preview tracks the same args the transcript holds so the lane
              // and the body never disagree about what is running.
              refreshToolPreview(session, entry.callId, entry.name, entry.arguments);
              return;
            }
            return;
          }
          case "inference.tool_call.end": {
            const data = event.data as { name?: unknown; callId?: unknown; arguments?: unknown };
            const callId = typeof data.callId === "string" ? data.callId : null;
            const name = typeof data.name === "string" ? data.name : null;
            const args =
              data.arguments !== undefined
                ? capText(stringifyUnknown(data.arguments), maxEntryChars)
                : null;
            for (let i = session.entries.length - 1; i >= 0; i--) {
              const entry = session.entries[i];
              if (entry?.kind !== "tool") continue;
              if (callId !== null && entry.callId !== callId) continue;
              if (name !== null) entry.name = name;
              if (args !== null && args.length > 0) entry.arguments = args;
              // Arguments finished streaming; the call itself is still in
              // flight, so this renames it rather than restarting its clock.
              beginToolCall(session, entry.callId, entry.name, now(), false, entry.arguments);
              return;
            }
            // No matching start — record a complete tool entry.
            if (name !== null) {
              const idForEntry = callId ?? `${name}-${session.entries.length}`;
              if (!session.toolNames.includes(name)) session.toolNames.push(name);
              beginToolCall(session, idForEntry, name, now(), false, args ?? "");
              pushEntry(session, {
                kind: "tool",
                callId: idForEntry,
                name,
                arguments: args ?? "",
              });
            }
            return;
          }
          case "tool.start": {
            // tool.start is the execution-time counterpart of inference.tool_call.
            // Prefer inference events for the transcript; only fill gaps.
            const call = (
              event as {
                data?: { call?: { name?: unknown; id?: unknown; arguments?: unknown } };
              }
            ).data?.call;
            const name = typeof call?.name === "string" ? call.name : null;
            if (name === null) return;
            const callId = typeof call?.id === "string" ? call.id : null;
            const rawArgs =
              call?.arguments !== undefined
                ? capText(stringifyUnknown(call.arguments), maxEntryChars)
                : undefined;
            // Without an id there is no way to tell which of several parallel
            // calls this starts, and guessing would retime the wrong one. The
            // inference-side start already registered it, so leave it alone.
            if (callId !== null) {
              beginToolCall(session, callId, name, now(), true, rawArgs);
            }
            if (!session.toolNames.includes(name)) session.toolNames.push(name);
            return;
          }
          case "tool.done": {
            const result = (
              event.data as {
                result?: { callId?: unknown; content?: unknown; isError?: unknown };
              }
            )?.result;
            if (result === undefined) return;
            const callId =
              typeof result.callId === "string"
                ? result.callId
                : `result-${session.entries.length}`;
            let name = "tool";
            for (let i = session.entries.length - 1; i >= 0; i--) {
              const entry = session.entries[i];
              if (entry?.kind === "tool" && entry.callId === callId) {
                name = entry.name;
                break;
              }
            }
            const content = capText(stringifyUnknown(result.content ?? ""), maxEntryChars);
            const isError = result.isError === true;
            pushEntry(session, { kind: "tool_result", callId, name, content, isError });
            endToolCall(session, callId);
            return;
          }
          default:
            return;
        }
      });
    },

    complete(
      id: string,
      report: string,
      opts?: { agentRetained?: boolean; stopReason?: ForcedStopReason },
    ): void {
      settleCancelsAsks(id, "session completed");
      // CL-7001: run.ts always disposes on a salvage return (deadline/cancel)
      // even though it resolves through this same success path — only trust
      // "still open, resumable" when the caller says the agent genuinely
      // survived this turn.
      // Defaults true: complete() historically meant "clean completion," and
      // tests call it that way with no opts at all. Only agent-fleet's
      // spawn_agent path ever has a salvage to report, and it
      // always passes this flag explicitly (see its call site).
      const agentRetained = opts?.agentRetained ?? true;
      mutate(id, (session) => {
        // Cancel and interrupt_agent win races: a late complete must not
        // resurrect the session as done. Interrupted is still strip-live
        // (linger), so it needs an explicit check. Salvage bodies attach via
        // attachReport without changing state. send_input interrupt:true
        // followup goes through beginFollowupTurn (running) and still completes.
        if (
          !isLiveStrip(session.lifecycle) ||
          session.lifecycle.state === "cancelled" ||
          session.lifecycle.state === "interrupted"
        ) {
          return;
        }
        session.lifecycle = { state: "completed", report };
        if (!agentRetained) session.retained = false;
        session.finishedAt = now();
        clearToolCalls(session);
        session.report = report;
        if (opts?.stopReason !== undefined) session.stopReason = opts.stopReason;
        pushEntry(session, { kind: "report", content: capText(report, maxEntryChars) });
        // A disposed salvage has nothing left for its close handle to do —
        // release it now rather than leaving a stale reference around.
        cancelHandles.delete(id);
        if (!agentRetained) closeHandles.delete(id);
        runInFlight.delete(id);
        pruneCompleted();
        pruneRetained();
      });
    },

    fail(id: string, error: string): void {
      settleCancelsAsks(id, "session failed");
      mutate(id, (session) => {
        if (!isLiveStrip(session.lifecycle) || session.lifecycle.state === "cancelled") return;
        // Spawn-path throws already dispose in run.ts's finally. Resume of a
        // persisted agent does not: the live close handle is the only teardown.
        // Invoke it fire-and-forget (same as prune/evict) without marking
        // shutdown — fail stays fail, and an already-disposed spawn close is
        // best-effort idempotent.
        session.lifecycle = { state: "failed", error };
        session.retained = false;
        session.finishedAt = now();
        clearToolCalls(session);
        session.error = error;
        pushEntry(session, {
          kind: "report",
          content: capText(`Error: ${error}`, maxEntryChars),
        });
        runInFlight.delete(id);
        releaseHandles(id);
        pruneCompleted();
      });
    },

    registerCancel(id: string, abort: () => void): void {
      const session = sessions.get(id);
      if (session === undefined || !isLiveStrip(session.lifecycle)) return;
      cancelHandles.set(id, abort);
    },

    markRunning(id: string): void {
      mutate(id, (session) => {
        if (session.lifecycle.state === "pending_init") session.lifecycle = { state: "running" };
      });
    },

    registerClose(id: string, close: (deadlineMs?: number) => Promise<void>): void {
      if (!sessions.has(id)) return;
      closeHandles.set(id, close);
      // CL-7001: wake anything blocked in closeOne's waitForCloseHandle below —
      // a close_agent call that arrived during the agent-setup window (before
      // this registration) is waiting on exactly this notification instead of
      // reporting false success over an unreleasable session.
      notify();
    },

    async closeOne(id: string, deadlineMs: number): Promise<AgentLifecycleStatus> {
      const session = sessions.get(id);
      if (session === undefined) {
        // CL-7007: an id evicted by pruneRetained already had its handles
        // released — from close_agent's perspective that is indistinguishable
        // from "already shut down", not a bad id.
        if (evicted.has(id)) return "shutdown";
        return "not_found";
      }
      settleCancelsAsks(id, "session closed");
      let close = closeHandles.get(id);
      const alreadyClosed = isAlreadyClosed(session.lifecycle);
      if (alreadyClosed && close === undefined) {
        return projectLifecycleStatus(session.lifecycle);
      }
      if (close === undefined) {
        // CL-7001: close_agent landed in the setup window — the session
        // exists but createAgentWithLiveToolDispatch hasn't finished and
        // registerClose hasn't fired yet. Wait for it (bounded) instead of
        // returning "shutdown" immediately: that used to report false
        // success while leaving the eventual agent unreleasable forever
        // (the early return above short-circuits every retry once
        // lifecycle flips).
        close = await waitForCloseHandle(id, deadlineMs);
        const stillHere = sessions.get(id);
        if (stillHere === undefined) return "not_found";
        if (close === undefined) {
          // Never became closeable within the deadline, or fail() already
          // released the handle: report the honest stored status rather
          // than a false "shutdown".
          return projectLifecycleStatus(stillHere.lifecycle);
        }
      }
      const keepFailed = isAlreadyClosed((sessions.get(id) ?? session).lifecycle);
      closeHandles.delete(id);
      // Bounded here too, defense-in-depth against a caller-registered
      // close that does not honor its own deadline argument — a wedged
      // descendant must not hang the whole close_agent call.
      await Promise.race([
        close(deadlineMs).catch((err: unknown) => {
          log.warn("session close raced deadline: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
        }),
        new Promise<void>((resolve) => setTimeout(resolve, deadlineMs)),
      ]);
      if (keepFailed) {
        // fail() already stamped failed; invoke leftover teardown without
        // rewriting that to shutdown.
        cancelHandles.delete(id);
        interruptHandles.delete(id);
        followupHandles.delete(id);
        deliverHandles.delete(id);
        runInFlight.delete(id);
        pruneCompleted();
        const after = sessions.get(id);
        return after === undefined ? "not_found" : projectLifecycleStatus(after.lifecycle);
      }
      mutate(id, (s) => {
        const wasLive = isLiveStrip(s.lifecycle);
        const error = s.error ?? (wasLive ? "Closed by close_agent" : undefined);
        if (wasLive) {
          s.finishedAt = s.finishedAt ?? now();
          if (error !== undefined) s.error = error;
        }
        s.lifecycle = {
          state: "shutdown",
          ...(s.report !== undefined ? { report: s.report } : {}),
          ...(error !== undefined ? { error } : {}),
        };
        s.retained = false;
      });
      cancelHandles.delete(id);
      interruptHandles.delete(id);
      followupHandles.delete(id);
      deliverHandles.delete(id);
      runInFlight.delete(id);
      pruneCompleted();
      return "shutdown";
    },

    registerInterrupt(id: string, interrupt: () => void): void {
      if (!sessions.has(id)) return;
      interruptHandles.set(id, interrupt);
    },

    registerFollowup(id: string, followup: (message: string) => Promise<string>): void {
      if (!sessions.has(id)) return;
      followupHandles.set(id, followup);
    },

    registerDeliver(id: string, deliver: (message: string) => void): void {
      if (!sessions.has(id)) return;
      deliverHandles.set(id, deliver);
    },

    sendInputOne(
      id: string,
      message: string,
      opts?: { interrupt?: boolean; onFollowupReply?: (reply: string) => void },
    ): { ok: true; status: AgentLifecycleStatus } | { ok: false; status: AgentLifecycleStatus } {
      const session = sessions.get(id);
      if (session === undefined) return { ok: false, status: "not_found" };
      if (session.lifecycle.state !== "running") {
        return { ok: false, status: projectLifecycleStatus(session.lifecycle) };
      }

      if (opts?.interrupt === true) {
        const interrupt = interruptHandles.get(id);
        const followup = followupHandles.get(id);
        if (interrupt === undefined || followup === undefined) {
          return { ok: false, status: projectLifecycleStatus(session.lifecycle) };
        }
        settleCancelsAsks(id, "cancelled by send_input interrupt");
        interrupt();
        queueFollowupTurn(id, message, "interrupted", {
          ...(opts.onFollowupReply !== undefined ? { onReply: opts.onFollowupReply } : {}),
        });
        pruneRetained();
        return { ok: true, status: "interrupted" };
      }

      if (pendingAsks.has(id)) {
        const pending = pendingAsks.get(id);
        if (pending !== undefined) {
          pendingAsks.delete(id);
          pending.resolve(message);
          notify();
        }
        return { ok: true, status: "running" };
      }

      const deliver = deliverHandles.get(id);
      if (deliver === undefined) {
        return { ok: false, status: projectLifecycleStatus(session.lifecycle) };
      }
      deliver(message);
      return { ok: true, status: "running" };
    },

    registerAsk(
      id: string,
      ask: {
        question: string;
        questionId: string;
        resolve: (answer: string) => void;
        reject: (reason: unknown) => void;
      },
    ): boolean {
      const session = sessions.get(id);
      if (session === undefined) return false;
      if (session.lifecycle.state !== "running") return false;
      if (pendingAsks.has(id)) return false;
      pendingAsks.set(id, ask);
      mutate(id, () => {});
      return true;
    },

    resolveAsk(id: string, answer: string): boolean {
      const pending = pendingAsks.get(id);
      if (pending === undefined) return false;
      pendingAsks.delete(id);
      pending.resolve(answer);
      notify();
      return true;
    },

    cancelAsk(id: string, reason = "ask_director cancelled"): boolean {
      return cancelAskInternal(id, reason);
    },

    hasPendingAsk(id: string): boolean {
      return pendingAsks.has(id);
    },

    peekAsk(id: string): { question: string; questionId: string } | undefined {
      const pending = pendingAsks.get(id);
      if (pending === undefined) return undefined;
      return { question: pending.question, questionId: pending.questionId };
    },

    interruptOne(id: string): { ok: true } | { ok: false; status: AgentLifecycleStatus } {
      const session = sessions.get(id);
      if (session === undefined) return { ok: false, status: "not_found" };
      if (!isLiveStrip(session.lifecycle)) {
        return { ok: false, status: projectLifecycleStatus(session.lifecycle) };
      }
      const interrupt = interruptHandles.get(id);
      if (interrupt === undefined) {
        return { ok: false, status: projectLifecycleStatus(session.lifecycle) };
      }
      settleCancelsAsks(id, "session interrupted");
      interrupt();
      mutate(id, (s) => {
        s.lifecycle = {
          state: "interrupted",
          ...(s.report !== undefined ? { report: s.report } : {}),
        };
        s.finishedAt = s.finishedAt ?? now();
      });
      pruneRetained();
      return { ok: true };
    },

    resumeOne(
      id: string,
      message: string,
      opts?: {
        onStart?: () => void;
        onReply?: (reply: string) => void;
        onFail?: (error: unknown) => void;
      },
    ):
      { ok: true; status: "running" } | { ok: false; status: AgentLifecycleStatus; hint?: string } {
      const session = sessions.get(id);
      if (session === undefined) {
        const tombstone = evicted.get(id);
        if (tombstone !== undefined) {
          return { ok: false, status: tombstone.lifecycleStatus, hint: tombstone.hint };
        }
        return { ok: false, status: "not_found" };
      }
      if (!isResumableLifecycle(session.retained, session.lifecycle)) {
        return { ok: false, status: projectLifecycleStatus(session.lifecycle) };
      }
      if (message.trim().length === 0) {
        return {
          ok: false,
          status: projectLifecycleStatus(session.lifecycle),
          hint: "resume_agent requires a non-empty message.",
        };
      }
      if (message.length > maxEntryChars) {
        return {
          ok: false,
          status: projectLifecycleStatus(session.lifecycle),
          hint:
            `resume_agent message exceeds ${maxEntryChars} characters ` +
            `(got ${message.length}).`,
        };
      }
      const followup = followupHandles.get(id);
      if (followup === undefined) {
        return { ok: false, status: projectLifecycleStatus(session.lifecycle) };
      }
      const priorLifecycle =
        session.lifecycle.state === "interrupted" ? "interrupted" : "completed";
      queueFollowupTurn(id, message, priorLifecycle, {
        ...(opts?.onReply !== undefined ? { onReply: opts.onReply } : {}),
        ...(opts?.onFail !== undefined ? { onFail: opts.onFail } : {}),
      });
      opts?.onStart?.();
      pruneRetained();
      return { ok: true, status: "running" };
    },

    cancel(id: string, reason = DEFAULT_CANCEL_REASON): boolean {
      return cancelSession(id, reason);
    },

    cancelAll(reason = DEFAULT_CANCEL_REASON): string[] {
      // Snapshot before cancelSession: markCancelled clears retained, and a
      // resumed retained worker is strip-live so the first loop would otherwise
      // skip the close-handle pass (CL-7001).
      const retainedIds = [...sessions.values()]
        .filter((s) => s.retained === true && s.lifecycle.state !== "shutdown")
        .map((s) => s.id);
      const running = [...sessions.values()].filter((s) => isLiveStrip(s.lifecycle));
      const cancelled: string[] = [];
      for (const session of running) {
        if (cancelSession(session.id, reason)) cancelled.push(session.id);
      }
      for (const id of retainedIds) {
        const session = sessions.get(id);
        if (session === undefined || session.lifecycle.state === "shutdown") continue;
        releaseHandles(id);
        mutate(id, (s) => {
          s.lifecycle = {
            state: "shutdown",
            ...(s.report !== undefined ? { report: s.report } : {}),
            ...(s.error !== undefined ? { error: s.error } : {}),
          };
          s.retained = false;
        });
      }
      return cancelled;
    },

    pin(id: string): void {
      pinCounts.set(id, (pinCounts.get(id) ?? 0) + 1);
    },

    unpin(id: string): void {
      const next = (pinCounts.get(id) ?? 0) - 1;
      if (next <= 0) {
        pinCounts.delete(id);
        pruneCompleted();
        pruneRetained();
      } else pinCounts.set(id, next);
    },

    attachReport(id: string, report: string): void {
      mutate(id, (session) => {
        const state = session.lifecycle.state;
        if (state === "completed" || state === "failed") {
          runInFlight.delete(id);
          return;
        }
        if (state === "pending_init" || state === "running") {
          session.lifecycle = { state: "interrupted", report };
          session.report = report;
          session.finishedAt = session.finishedAt ?? now();
          pushEntry(session, { kind: "report", content: capText(report, maxEntryChars) });
        } else if (
          (state === "cancelled" || state === "interrupted" || state === "shutdown") &&
          session.report === undefined
        ) {
          session.report = report;
          session.lifecycle = { ...session.lifecycle, report };
          pushEntry(session, { kind: "report", content: capText(report, maxEntryChars) });
        }
        runInFlight.delete(id);
        pruneCompleted();
        pruneRetained();
      });
    },

    isRunInFlight(id: string): boolean {
      return runInFlight.has(id);
    },

    settleRun(id: string): void {
      cancelAskInternal(id, "run settled");
      if (!runInFlight.delete(id)) return;
      notify();
    },

    wake(): void {
      notify();
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    clear(): void {
      // CL-7001: invoke every registered close (best-effort, fire-and-forget)
      // before dropping the maps — this used to drop closeHandles without
      // calling them, leaking every retained session's agent permanently.
      for (const id of pendingAsks.keys()) cancelAskInternal(id, "store cleared");
      for (const id of closeHandles.keys()) releaseHandles(id);
      cancelHandles.clear();
      closeHandles.clear();
      interruptHandles.clear();
      followupHandles.clear();
      deliverHandles.clear();
      sessions.clear();
      pinCounts.clear();
      runInFlight.clear();
      revisions.clear();
      snapshotCache.clear();
      evicted.clear();
      notify();
    },
  };
}

function cloneSession(session: StoredSession): SubAgentSession {
  return {
    id: session.id,
    description: session.description,
    agentId: session.agentId,
    brief: session.brief,
    status: projectStripStatus(session.lifecycle),
    lifecycle: { ...session.lifecycle },
    toolNames: [...session.toolNames],
    currentToolName: session.currentToolName,
    currentToolPreview: session.currentToolPreview,
    currentToolStartedAt: session.currentToolStartedAt,
    outstandingTools: session.outstandingTools.map((c) => ({ ...c })),
    entries: session.entries.map(cloneEntry),
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    lifecycleStatus: projectLifecycleStatus(session.lifecycle),
    ...(session.retained !== undefined ? { retained: session.retained } : {}),
    ...(session.finishedAt !== undefined ? { finishedAt: session.finishedAt } : {}),
    ...(session.report !== undefined ? { report: session.report } : {}),
    ...(session.error !== undefined ? { error: session.error } : {}),
    ...(session.stopReason !== undefined ? { stopReason: session.stopReason } : {}),
    ...(session.parentSessionId !== undefined ? { parentSessionId: session.parentSessionId } : {}),
  };
}

function cloneEntry(entry: SubAgentTranscriptEntry): SubAgentTranscriptEntry {
  switch (entry.kind) {
    case "text":
    case "thinking":
    case "report":
      return { kind: entry.kind, content: entry.content };
    case "tool":
      return {
        kind: "tool",
        callId: entry.callId,
        name: entry.name,
        arguments: entry.arguments,
      };
    case "tool_result":
      return {
        kind: "tool_result",
        callId: entry.callId,
        name: entry.name,
        content: entry.content,
        isError: entry.isError,
      };
  }
}
