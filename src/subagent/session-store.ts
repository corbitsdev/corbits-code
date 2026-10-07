// In-memory registry of sub-agent sessions for TUI inspection. Keeps full
// child text out of the parent turn; the enter-session UI reads this.

import type { ReactorEmittedEvent } from "@intx/inference";
import { AgentClosedError } from "@intx/agent";
import { getLogger } from "@intx/log";
import { LOG_NAMESPACE_ROOT } from "../branding.js";
import { awaitBoundedTeardown, DEFAULT_CLOSE_DEADLINE_MS } from "./dispose.js";
import { errorMessage } from "../agent/error-message.js";
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
import {
  getProcessWorkerGrantStore,
  type WorkerDeniedCallEnvelope,
} from "../permission/worker-grant.js";
import type { AdmissionQueue, AdmissionStatus } from "./admission.js";

const log = getLogger([LOG_NAMESPACE_ROOT, "subagent", "session-store"]);

async function invokeCloseBounded(
  close: (deadlineMs?: number) => Promise<void>,
  deadlineMs: number,
): Promise<void> {
  try {
    await awaitBoundedTeardown(close(deadlineMs), deadlineMs);
  } catch (err: unknown) {
    log.warn("session close raced deadline: {error}", {
      error: errorMessage(err),
    });
    throw err;
  }
}

export type SubAgentSessionStatus = "running" | "done" | "failed" | "cancelled";

/** Lifecycle for close_agent/resume_agent; snapshot projects
 * `WorkerLifecycle` (cancelled → interrupted, failed → shutdown).
 * `not_found` is query-only, never stored. */
export type AgentLifecycleStatus =
  | "pending_init"
  | "running"
  | "interrupted"
  | "completed"
  | "shutdown"
  | "not_found";

export type { WorkerLifecycle };

// TUI-renderable transcript entries, avoiding a subagent → tui dependency.
export type SubAgentTranscriptEntry =
  | { kind: "text"; content: string }
  | { kind: "thinking"; content: string }
  | { kind: "tool"; callId: string; name: string; arguments: string }
  | {
      kind: "tool_result";
      callId: string;
      name: string;
      content: string;
      isError: boolean;
    }
  | { kind: "report"; content: string };

export interface OutstandingToolCall {
  callId: string;
  name: string;
  startedAt: number;
  /** One-line subject (command, path…), or null when the args show nothing.
   * Same source as the transcript entry, so lane and body cannot disagree. */
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
  // Oldest outstanding call. A worker in one long tool emits nothing, so
  // its start clock separates wedged from busy. Derived from
  // `outstandingTools`; never assign directly.
  currentToolName: string | null;
  currentToolPreview: string | null;
  currentToolStartedAt: number | null;
  // Calls started but not yet reported. Parallel calls run concurrently;
  // one scalar would let a fast sibling's finish retire a long call's clock.
  outstandingTools: OutstandingToolCall[];
  entries: SubAgentTranscriptEntry[];
  startedAt: number;
  // Clock of the last event. Distinct from startedAt so the strip can tell a
  // mid-turn worker from a silent one.
  lastActivityAt: number;
  // Clock the live turn ended (interrupt can stamp while status is still
  // "running"). Drives chrome linger; tools may still be outstanding after.
  finishedAt?: number;
  report?: string;
  error?: string;
  /** ForcedStopReason from runSubAgent, or `cancelled — <reason>` on
   * cancel(). Absent on clean completes; never parsed from report prose. */
  stopReason?: string;
  // Id of the orchestrator that dispatched this worker. Undefined for
  // top-level sessions.
  parentSessionId?: string;
  /** Catalog provider id used for followup admission. */
  provider?: string;
  /** True while an admitted run or followup has not settled. */
  runInFlight?: boolean;
  /** Projection of `lifecycle` for close/resume/interrupt JSON: cancelled →
   * interrupted, failed → shutdown. */
  lifecycleStatus: AgentLifecycleStatus;
  // True when the agent survives a clean completion (spawn_agent opts in).
  // Capped by `maxRetained`, not `maxCompleted`; close_agent flips it back.
  retained?: boolean;
  /** Canonical tool names hard-required at dispatch. Verified pre-spawn; the
   * mount re-checks and fails a stale snapshot if one went missing. */
  requiresTools?: readonly string[];
}

export interface StartSessionInput {
  description: string;
  agentId: string;
  brief: string;
  // External id (e.g. parent tool callId) so the strip can correlate
  // progress with the session. Generated when omitted.
  id?: string;
  // Nest this session under its orchestrator in the strip.
  parentSessionId?: string;
  // Opt in to end-of-turn retention (spawn_agent sets this).
  retained?: boolean;
  /** Catalog provider id for followup admission. */
  provider?: string;
  /** Canonical tool names this worker hard-required at dispatch. */
  requiresTools?: readonly string[];
}

export interface SubAgentSessionStoreOptions {
  // Cap on completed/failed sessions retained after finish. Running sessions
  // are never pruned by it; open retained sessions use maxRetained instead.
  maxCompleted?: number;
  // Cap on open retained sessions (still resumable), sized for fan-out,
  // independent of maxCompleted's TUI display cap. Least-recently-used
  // evicted first; running sessions are never evicted.
  maxRetained?: number;
  // Cap on transcript entries per session (oldest dropped).
  maxEntries?: number;
  // Cap on characters per text/thinking/result entry.
  maxEntryChars?: number;
  now?: () => number;
  createId?: () => string;
  /** When set, resume/followup inference is admitted through this queue. */
  admission?: AdmissionQueue;
}

export interface SubAgentSessionStore {
  list(): readonly SubAgentSession[];
  get(id: string): SubAgentSession | undefined;
  /** Terminal lifecycle of a pruneRetained-evicted session, if a tombstone
   * remains. `get` skips these; wait/resume use them instead of not_found. */
  evictedLifecycle(id: string): AgentLifecycleStatus | undefined;
  // Running + recent completed, newest first — surface for the Agents strip.
  listForStrip(): readonly SubAgentSession[];
  start(input: StartSessionInput): SubAgentSession;
  appendEvent(id: string, event: ReactorEmittedEvent): void;
  // `agentRetained` mirrors run.ts's turnSucceeded gate (true only when the
  // caller skipped teardown); false keeps a disposed session from ever
  // reporting as resumable.
  complete(
    id: string,
    report: string,
    opts?: { agentRetained?: boolean; stopReason?: ForcedStopReason },
  ): void;
  fail(id: string, error: string): void;
  // Register the live abort handle so cancel() stops the child reactor
  // (agent.close), not just flips status.
  registerCancel(id: string, abort: () => void): void;
  // Abort a running session and mark it cancelled. True if cancelled; false
  // if missing or already terminal.
  cancel(id: string, reason?: string): boolean;
  // Cancel every running session; closes retained workers under closeOne's
  // deadline — hung closes reject while children may still be live.
  // Returns the ids cancelled.
  cancelAll(reason?: string): Promise<string[]>;
  // Flips "pending_init" to "running" once its agent actually exists.
  // No-op on an unknown id or one past init.
  markRunning(id: string): void;
  /** Mark the admitted run as in-flight. Deferred until admission, not start(). */
  markRunInFlight(id: string): void;
  // Registers the bounded close function close_agent will call. One per id;
  // a later call replaces an earlier one.
  registerClose(
    id: string,
    close: (deadlineMs?: number) => Promise<void>,
  ): void;
  // Runs the registered close (bounded by deadlineMs), marks "shutdown" —
  // terminal, no longer exempt from pruneCompleted. Idempotent; an unknown
  // id resolves "not_found" without throwing.
  closeOne(id: string, deadlineMs: number): Promise<AgentLifecycleStatus>;
  // Resumes a retained, still-open ("completed"/"interrupted") session via
  // the followup handle; wait_agents collects the reply. Fails closed
  // otherwise: "shutdown" permanent, running concurrent, "pending_init"/
  // "not_found" nothing to resume. Evicted sessions report terminal
  // lifecycleStatus plus a `hint` at read_agent_trace.
  resumeOne(
    id: string,
    message: string,
    opts?: {
      onStart?: () => void;
      onReply?: (reply: string) => void;
      onFail?: (error: unknown) => void;
    },
  ):
    | { ok: true; status: "running" | "queued" }
    | { ok: false; status: AgentLifecycleStatus; hint?: string };
  // Registers the interrupt/followup handles run.ts hands back via
  // onAgentReady, distinct from close handles so an interrupt never routes
  // through close's codepath.
  registerInterrupt(id: string, interrupt: () => void): void;
  registerFollowup(
    id: string,
    followup: (message: string) => Promise<string>,
  ): void;
  // Fires the registered interrupt handle and flips to "interrupted"
  // synchronously — the caller does not wait for the run to settle. Fails
  // closed unless running with the handle.
  interruptOne(
    id: string,
  ): { ok: true } | { ok: false; status: AgentLifecycleStatus };
  registerDeliver(id: string, deliver: (message: string) => void): void;
  sendInputOne(
    id: string,
    message: string,
    opts?: {
      interrupt?: boolean;
      onFollowupReply?: (reply: string) => void;
      onStart?: () => void;
      onFail?: (error: unknown) => void;
    },
  ):
    | { ok: true; status: AgentLifecycleStatus }
    | { ok: false; status: AgentLifecycleStatus; hint?: string };
  /** One pending ask_director per session. `sendInputOne` resolves it;
   * interrupt/settle/close cancel it. Wait JSON projects this, not
   * lifecycle. */
  registerAsk(
    id: string,
    ask: {
      question: string;
      questionId: string;
      /** Grant requestId quoted from the deny reason: binds this ask to
       * its own denial instead of the session's first pending envelope. */
      grantRequestId?: string;
      resolve: (answer: string) => void;
      reject: (reason: unknown) => void;
    },
  ): boolean;
  resolveAsk(id: string, answer: string): boolean;
  cancelAsk(id: string, reason?: string): boolean;
  hasPendingAsk(id: string): boolean;
  peekAsk(id: string):
    | {
        question: string;
        questionId: string;
        deniedCall?: WorkerDeniedCallEnvelope;
      }
    | undefined;
  /** Reject asks older than `maxAgeMs` with a timeout error naming question
   * and session. Returns the expired descriptors; settlement stays
   * exactly-once via the same path as resolve/cancelAsk. */
  expireStaleAsks(
    maxAgeMs: number,
  ): readonly { sessionId: string; questionId: string }[];
  /** Refcount so wait mailboxes can pin an uncollected result; pruneCompleted
   * keeps nonzero-pinned sessions. */
  pin(id: string): void;
  unpin(id: string): void;
  /** Attach a salvage report to cancelled/interrupted/shutdown without
   * changing `state`; never overwrites an existing report. A live
   * pending_init/running session flips to interrupted; waiters notified. */
  attachReport(
    id: string,
    report: string,
    opts?: { stopReason?: ForcedStopReason },
  ): void;
  /** True while a run or followup has not settled. */
  isRunInFlight(id: string): boolean;
  /** Catch-path settle: clear the in-flight bit without changing lifecycle,
   * so operator cancel becomes wait-terminal when there is no salvage body. */
  settleRun(id: string): void;
  /** Wake subscribers without mutating a session (mailbox overlay writers). */
  wake(): void;
  subscribe(listener: () => void): () => void;
  clear(): void;
  /** Stop teardown: like `clear`, but leaves a tombstone per session so a
   * late `sendInputOne` fails closed naming the teardown, not a bare
   * `not_found`. */
  teardown(reason?: string): void;
}

export const DEFAULT_CANCEL_REASON = "Cancelled by operator";

/** Ask deadline: a parked `ask_director` question older than this settles via
 * `expireStaleAsks` with a timeout error, so a stalled-wake worker never
 * waits forever. Twice the stall abort bound: a re-surfaced wake turn gets
 * a full cycle to prove the parent alive. */
export const ASK_DEADLINE_MS = 1_800_000;

const DEFAULT_MAX_COMPLETED = 20;
// Sized for fan-out dispatch (dozens of spawn_agent workers), not a sidebar
// list — see maxRetained doc above.
const DEFAULT_MAX_RETAINED = 50;
const DEFAULT_MAX_ENTRIES = 400;
/** Cap on characters per transcript entry / send_input message body. */
export const DEFAULT_MAX_ENTRY_CHARS = 24_000;

const EVICTED_RETENTION_HINT =
  "Session evicted to bound retained-session memory; recover full detail via read_agent_trace(agent_id).";

// Tombstone cap for evicted sessions, so short-lived retained workers cannot
// grow this map forever.
const MAX_EVICTED_TOMBSTONES = 500;

/** Resolves a configured cap, guarding non-finite values (e.g. a JSON
 * round-trip turned `Infinity` into `null`) so it never collapses to
 * `0`/`NaN`. */
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

/** Only place the displayed triple is produced, so a name/preview never shows
 * beside another call's clock. Called after every `outstandingTools` change. */
function syncCurrentTool(session: StoredSession): void {
  let oldest: OutstandingToolCall | undefined;
  for (const call of session.outstandingTools) {
    if (oldest === undefined || call.startedAt < oldest.startedAt)
      oldest = call;
  }
  session.currentToolName = oldest?.name ?? null;
  session.currentToolPreview = oldest?.preview ?? null;
  session.currentToolStartedAt = oldest?.startedAt ?? null;
}

/** `restartClock` marks the execution boundary: streaming already registered
 * the call, so the clock shows run time. `rawArgs` refreshes the lane preview
 * from the transcript payload. */
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
    rawArgs !== undefined
      ? toolCallPreview(name, rawArgs)
      : (existing?.preview ?? null);
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

/** Retires exactly the call that finished; an unknown id retires nothing
 * rather than silently clearing a live sibling's clock. */
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
  const admission = options.admission;

  // Insertion order: older first. list() returns a snapshot in that order.
  const sessions = new Map<string, StoredSession>();
  // Pin refcount: wait mailboxes hold a pin until they collect the result.
  const pinCounts = new Map<string, number>();
  // Live run/followup: operator cancel is wait-terminal only after this clears.
  const runInFlight = new Set<string>();
  // Live abort hooks keyed by session id. Cleared on terminal transition.
  const cancelHandles = new Map<string, () => void>();
  // Bounded close functions for close_agent. Distinct from cancelHandles
  // (a synchronous abort) because closing must be awaitable and bounded.
  const closeHandles = new Map<
    string,
    (deadlineMs?: number) => Promise<void>
  >();
  // Interrupt/followup handles, kept separate from closeHandles so an
  // interrupt never resolves through the close codepath.
  const interruptHandles = new Map<string, () => void>();
  const followupHandles = new Map<
    string,
    (message: string) => Promise<string>
  >();
  const deliverHandles = new Map<string, (message: string) => void>();
  // A send_input interrupt landing while the original run is still in flight
  // must not start its follow-up against a run about to settle. Stashed, it
  // launches from the attachReport handoff; complete() launches it fresh
  // when the run wins the race. Any other terminal transition drops the
  // queue loudly — a follow-up never runs against a closed agent.
  interface StashedFollowup {
    message: string;
    failLifecycle: "completed" | "interrupted";
    onStart?: () => void;
    onReply?: (reply: string) => void;
    onFail?: (error: unknown) => void;
  }
  // Overlapping interrupt-steers queue FIFO per session. The head launches
  // when the live run settles (attachReport handoff or complete()'s
  // deliverStash); each settled follow-up launches the next.
  const stashedFollowups = new Map<string, StashedFollowup[]>();

  const steerPreview = (message: string): string => {
    const firstLine = message.split("\n", 1)[0] ?? "";
    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  };

  // A superseded steer fails loudly: each queued steer is rejected with what
  // was lost and why, and the loss lands on the session transcript.
  const dropStashedFollowups = (id: string, reason: string): void => {
    const queue = stashedFollowups.get(id);
    if (queue === undefined || queue.length === 0) {
      stashedFollowups.delete(id);
      return;
    }
    stashedFollowups.delete(id);
    const lost = queue
      .map((stashed) => `"${steerPreview(stashed.message)}"`)
      .join(", ");
    for (const stashed of queue) {
      try {
        stashed.onFail?.(
          new Error(
            `send_input steer "${steerPreview(stashed.message)}" dropped (${reason})`,
          ),
        );
      } catch {
        // A throwing onFail must not break session settlement.
      }
    }
    mutate(id, (session) => {
      pushEntry(session, {
        kind: "report",
        content: capText(
          `Steer ${queue.length === 1 ? "dropped" : `${queue.length} steers dropped`} (${reason}): ${lost}`,
          maxEntryChars,
        ),
      });
    });
  };
  const pendingAsks = new Map<
    string,
    {
      question: string;
      questionId: string;
      resolve: (answer: string) => void;
      reject: (reason: unknown) => void;
      // Registration clock for the ask deadline: an ask parked longer than
      // the bound settles via `expireStaleAsks` instead of waiting on a wake
      // turn that may never land.
      askedAt: number;
      // Harness-owned denied-call envelope (exact ToolCall + hash) attached
      // at registerAsk. Parent replays from this record; model prose is never
      // authoritative.
      deniedCall?: WorkerDeniedCallEnvelope;
    }
  >();
  const listeners = new Set<() => void>();
  // Tombstones for pruneRetained-evicted sessions, insertion-ordered so the
  // oldest drops first past MAX_EVICTED_TOMBSTONES. Lets resume_agent report
  // an actionable terminal status instead of "not_found".
  const evicted = new Map<string, EvictedRecord>();

  const recordEviction = (session: StoredSession): void => {
    evicted.set(session.id, {
      lifecycleStatus: projectLifecycleStatus(session.lifecycle),
      hint: EVICTED_RETENTION_HINT,
    });
    // An evicted session's denied-call envelopes fail closed — a later
    // replay names the eviction instead of riding a lingering grant.
    try {
      getProcessWorkerGrantStore().invalidateSession(
        session.id,
        EVICTED_RETENTION_HINT,
      );
    } catch {
      // Grant invalidation must not throw out of eviction.
    }
    if (evicted.size > MAX_EVICTED_TOMBSTONES) {
      const oldest = evicted.keys().next().value;
      if (oldest !== undefined) evicted.delete(oldest);
    }
  };

  // Revision counters, bumped on every mutation. Notify fires on every
  // streamed token, so list()/get()/listForStrip() would otherwise deep-clone
  // every session's entries per token. A cache keyed by revision lets
  // unrelated sessions reuse theirs.
  const revisions = new Map<string, number>();
  const snapshotCache = new Map<
    string,
    { revision: number; snapshot: SubAgentSession }
  >();

  const bumpRevision = (id: string): void => {
    revisions.set(id, (revisions.get(id) ?? 0) + 1);
  };

  const forgetRevision = (id: string): void => {
    revisions.delete(id);
    snapshotCache.delete(id);
  };

  const snapshotOf = (session: StoredSession): SubAgentSession => {
    const revision = revisions.get(session.id) ?? 0;
    const inFlight = runInFlight.has(session.id);
    const cached = snapshotCache.get(session.id);
    if (
      cached !== undefined &&
      cached.revision === revision &&
      cached.snapshot.runInFlight === inFlight
    ) {
      return cached.snapshot;
    }
    const snapshot = cloneSession(session, inFlight);
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

  const cancelAskInternal = (
    id: string,
    reason: string,
    silent = false,
    keepGrants = false,
  ): boolean => {
    const pending = pendingAsks.get(id);
    if (pending === undefined) return false;
    pendingAsks.delete(id);
    if (!keepGrants) {
      // Interrupt/cancel invalidation — tombstone the session's denied-call
      // envelopes so a later replay fails closed with a truthful blocker
      // instead of riding whatever grant the gate holds. Retained run-settle
      // keeps them (keepGrants): resume_agent retry is the retry path.
      try {
        getProcessWorkerGrantStore().invalidateSession(id, reason);
      } catch {
        // Grant invalidation must not throw into settle/interrupt paths.
      }
    }
    try {
      pending.reject(new Error(reason));
    } catch {
      // Reject must not throw into settle/interrupt paths.
    }
    if (!silent) notify();
    return true;
  };

  const cancelDescendantAsks = (ancestorId: string, reason: string): void => {
    for (const session of sessions.values()) {
      if (session.id === ancestorId) continue;
      if (isSessionUnder(session.id, ancestorId))
        cancelAskInternal(session.id, reason);
    }
  };

  const settleCancelsAsks = (id: string, reason: string): void => {
    cancelAskInternal(id, reason);
    cancelDescendantAsks(id, reason);
  };

  // Invariant: a non-live lifecycle never coexists with a run-in-flight
  // marker once no settle-capable handle remains. A soft-interrupted run
  // still holds its interrupt/close/followup/deliver handles and settles
  // through them; anything else reaching a terminal state through mutate has
  // nothing left to settle it, so the store drops the marker. Cancel hooks
  // don't settle runs, so cancelHandles is not in the set; cancel itself is
  // excluded — see markCancelled: after cancel the marker is the live run's
  // settlement promise.
  const enforceSettledRunInvariant = (id: string): void => {
    const session = sessions.get(id);
    if (session === undefined || !runInFlight.has(id)) return;
    const state = session.lifecycle.state;
    if (state === "pending_init" || state === "running") return;
    if (
      interruptHandles.has(id) ||
      closeHandles.has(id) ||
      followupHandles.has(id) ||
      deliverHandles.has(id)
    )
      return;
    runInFlight.delete(id);
  };

  const markCancelled = (session: StoredSession, reason: string): void => {
    session.lifecycle = { state: "cancelled", error: reason };
    session.retained = false;
    session.finishedAt = now();
    session.lastActivityAt = now();
    clearToolCalls(session);
    session.error = reason;
    session.stopReason =
      reason === DEFAULT_CANCEL_REASON ? "cancelled" : `cancelled — ${reason}`;
    pushEntry(session, {
      kind: "report",
      content: capText(`Cancelled: ${reason}`, maxEntryChars),
    });
    cancelHandles.delete(session.id);
    // closeHandles are owned by releaseHandles / closeOne — dropping them
    // here would skip teardown for a retained mid-turn session.
    // No enforceSettledRunInvariant here: after cancel the marker is the
    // live run's settlement promise (salvage lands via attachReport);
    // clearing it would resolve wait_agents before the salvage arrives. The
    // stranded shape is closed at the pending_init interrupt branch and the
    // fleet's not-admissible early return instead.
    bumpRevision(session.id);
    pruneCompleted();
  };

  const cancelSession = (id: string, reason: string): boolean => {
    settleCancelsAsks(id, reason);
    // Cancelled steers are superseded — surface which were dropped.
    dropStashedFollowups(id, "session cancelled");
    const session = sessions.get(id);
    if (session === undefined || !isLiveStrip(session.lifecycle)) return false;
    const abort = cancelHandles.get(id);
    // Flip status first so concurrent complete/fail see a non-running
    // session, then fire the abort handle (may re-enter via signal listeners).
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

  const pushEntry = (
    session: StoredSession,
    entry: SubAgentTranscriptEntry,
  ): void => {
    session.entries.push(entry);
    if (session.entries.length > maxEntries) {
      session.entries.splice(0, session.entries.length - maxEntries);
    }
  };

  // Releases the store's handles for `id` — close (best-effort, so a wedged
  // descendant cannot stall the eviction caller) and cancel. Called whenever
  // a session record is dropped, so a retained-but-idle session's agent is
  // never simply forgotten.
  const releaseHandles = (id: string): void => {
    cancelAskInternal(id, "session handles released");
    const close = closeHandles.get(id);
    if (close !== undefined) {
      closeHandles.delete(id);
      void close(DEFAULT_CLOSE_DEADLINE_MS).catch((err: unknown) => {
        log.warn("session close during handle release failed: {error}", {
          error: errorMessage(err),
        });
      });
    }
    cancelHandles.delete(id);
    interruptHandles.delete(id);
    followupHandles.delete(id);
    deliverHandles.delete(id);
    // Backstop: every teardown path funnels through here, so a queue that
    // somehow survived its semantic drop point is surfaced, never silent.
    dropStashedFollowups(id, "session ended");
  };

  // An open retained session (retained:true and still addressable —
  // "completed" or "interrupted") is governed by pruneRetained's own cap,
  // not this one.
  const isOpenRetained = (s: StoredSession): boolean =>
    s.retained === true &&
    (s.lifecycle.state === "completed" || s.lifecycle.state === "interrupted");

  const isPinned = (id: string): boolean => (pinCounts.get(id) ?? 0) > 0;

  const isPrunableCompleted = (s: StoredSession): boolean =>
    !isLiveStrip(s.lifecycle) && !isOpenRetained(s) && !isPinned(s.id);

  // `maxCompleted` bounds every ordinary finished session — never retained,
  // or retained and already closed via close_agent (retained flips back to
  // false there). A TUI display cap, not retention policy: open retained
  // sessions are bounded by pruneRetained instead. Excluded: resumed active
  // sessions (live caller, not an idle leak) and pinned ids (uncollected
  // wait results).
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

  // Bounds open retained sessions (dozens-of-workers fan-out), the
  // resource-safety bound lost when retained sessions were folded into
  // pruneCompleted's TUI cap. Evicts least-recently-used first (by
  // lastActivityAt); a re-running session is never a candidate. Handles
  // release like pruneCompleted's eviction; a tombstone is kept so
  // resume_agent reports an actionable status instead of "not_found".
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

  // Resolves once `id` gets a close handle, goes shutdown, disappears, or
  // `deadlineMs` elapses (whichever first) — the wait closeOne uses for a
  // close_agent call that raced agent setup.
  const waitForCloseHandle = (
    id: string,
    deadlineMs: number,
  ): Promise<((deadlineMs?: number) => Promise<void>) | undefined> => {
    return new Promise((resolve) => {
      let settled = false;
      const listener = (): void => check();
      const finish = (
        value: ((deadlineMs?: number) => Promise<void>) | undefined,
      ): void => {
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
    enforceSettledRunInvariant(id);
    session.lastActivityAt = now();
    bumpRevision(id);
    notify();
  };

  // A follow-up turn takes the lane back over: the worker is live again, so
  // the interrupt's linger stamp must not outlive the new turn. Completion
  // re-stamps through the caller's own mutate; a rejected turn restores the
  // strip state it started from so resume_agent can retry. interrupt_agent's
  // stamp wins over that restore — never rewrite interrupted to completed.
  const beginFollowupTurn = (id: string): void => {
    runInFlight.add(id);
    mutate(id, (s) => {
      s.lifecycle = { state: "running" };
      delete s.finishedAt;
      delete s.stopReason;
    });
  };
  const endFollowupTurn = (
    id: string,
    restore: "completed" | "interrupted",
  ): void => {
    mutate(id, (s) => {
      if (
        s.lifecycle.state !== "running" &&
        s.lifecycle.state !== "pending_init"
      ) {
        s.finishedAt = s.finishedAt ?? now();
        if (restore === "interrupted" && s.stopReason === undefined) {
          s.stopReason = "interrupted";
        }
        return;
      }
      if (restore === "interrupted") {
        s.lifecycle = {
          state: "interrupted",
          ...(s.report !== undefined ? { report: s.report } : {}),
        };
        s.stopReason = "interrupted";
      } else {
        s.lifecycle = { state: "completed", report: s.report ?? "" };
      }
      s.finishedAt = now();
    });
  };
  // Shared terminal transition when a queued follow-up rejects because the
  // agent closed mid-invocation. Session and fleet move together:
  // endFollowupTurn restores the visible fleet state while fail records the
  // actionable error, so wait_agents, list_agents, and resume_agent agree.
  const failClosedSession = (id: string, error: string): void => {
    endFollowupTurn(id, "interrupted");
    settleCancelsAsks(id, "session failed");
    // The failed turn supersedes steers still queued behind it.
    dropStashedFollowups(id, "session failed");
    mutate(id, (session) => {
      if (
        !isLiveStrip(session.lifecycle) ||
        session.lifecycle.state === "cancelled"
      ) {
        return;
      }
      session.lifecycle = { state: "failed", error };
      session.finishedAt = now();
      session.lastActivityAt = now();
      session.error = error;
      session.stopReason = "error";
      clearToolCalls(session);
      pushEntry(session, {
        kind: "report",
        content: capText(`Error: ${error}`, maxEntryChars),
      });
    });
    releaseHandles(id);
    pruneCompleted();
  };
  // Shared follow-up settlement for queueFollowupTurn's immediate/queued
  // start and attachReport's stashed-interrupt launch, so every follow-up
  // completes, fails, and releases its admission slot the same way.
  const settleFollowupReply = (
    id: string,
    reply: string,
    onReply?: (reply: string) => void,
  ): void => {
    const still = sessions.get(id);
    if (still === undefined) {
      runInFlight.delete(id);
      // The session vanished with steers still queued — surface them.
      dropStashedFollowups(id, "session ended");
      return;
    }
    if (
      still.lifecycle.state === "shutdown" ||
      still.lifecycle.state === "cancelled" ||
      still.lifecycle.state === "failed" ||
      still.lifecycle.state === "interrupted"
    ) {
      runInFlight.delete(id);
      // The lane died with steers still queued — surface them.
      dropStashedFollowups(id, "session settled");
      return;
    }
    // More steers queued behind this one — record its reply and hand off to
    // the next steer in order instead of completing the session.
    if ((stashedFollowups.get(id)?.length ?? 0) > 0) {
      mutate(id, (s) => {
        s.report = reply;
        pushEntry(s, {
          kind: "report",
          content: capText(reply, maxEntryChars),
        });
      });
      try {
        onReply?.(reply);
      } catch {
        // A throwing onReply must not break the handoff to the next steer.
      }
      launchNextStashedFollowup(id);
      return;
    }
    mutate(id, (s) => {
      s.lifecycle = { state: "completed", report: reply };
      s.finishedAt = now();
      s.report = reply;
      delete s.stopReason;
      pushEntry(s, {
        kind: "report",
        content: capText(reply, maxEntryChars),
      });
    });
    runInFlight.delete(id);
    try {
      onReply?.(reply);
    } catch {
      // A throwing onReply must not break session settlement.
    }
    pruneRetained();
  };
  const settleFollowupFailure = (
    id: string,
    err: unknown,
    failLifecycle: "completed" | "interrupted",
    onFail?: (error: unknown) => void,
  ): void => {
    // A failed steer hands off to the next queued steer. The lane stays live
    // across the handoff so no observer sees a gap between turns; only the
    // last settlement restores the lane.
    if (
      !(err instanceof AgentClosedError) &&
      (stashedFollowups.get(id)?.length ?? 0) > 0
    ) {
      try {
        onFail?.(err);
      } catch {
        // A throwing onFail must not break the handoff to the next steer.
      }
      log.error("followup turn failed for {id}: {error}", {
        id,
        error: errorMessage(err),
      });
      launchNextStashedFollowup(id);
      return;
    }
    runInFlight.delete(id);
    try {
      onFail?.(err);
    } catch {
      // A throwing onFail must not break session settlement.
    }
    // The agent closed between queueing and invocation, so the follow-up can
    // never run. Move session and fleet records to the same terminal state
    // with an actionable error instead of silently restoring the stale
    // interrupted snapshot.
    if (err instanceof AgentClosedError) {
      failClosedSession(
        id,
        `Follow-up rejected: agent ${id} closed before the message could be delivered.`,
      );
      log.error("followup rejected for closed agent {id}", { id });
      return;
    }
    endFollowupTurn(id, failLifecycle);
    log.error("followup turn failed for {id}: {error}", {
      id,
      error: errorMessage(err),
    });
  };
  const queueFollowupTurn = (
    id: string,
    message: string,
    failLifecycle: "completed" | "interrupted",
    opts?: {
      onStart?: () => void;
      onReply?: (reply: string) => void;
      onFail?: (error: unknown) => void;
    },
  ): AdmissionStatus => {
    const followup = followupHandles.get(id);
    if (followup === undefined) return "running";
    const session = sessions.get(id);
    const queue = admission;
    // A followup on an already-admitted id must not enqueue a second job
    // (enqueue would no-op start) nor release the slot the first run still
    // holds.
    const takesSlot = queue !== undefined && !queue.occupied(id);
    const start = (): void => {
      beginFollowupTurn(id);
      try {
        opts?.onStart?.();
      } catch {
        // A throwing onStart must not break the follow-up turn.
      }
      void followup(message)
        .then((reply) => {
          settleFollowupReply(id, reply, opts?.onReply);
        })
        .catch((err: unknown) => {
          settleFollowupFailure(id, err, failLifecycle, opts?.onFail);
        })
        .finally(() => {
          if (takesSlot) queue?.release(id);
        });
    };
    if (!takesSlot || queue === undefined) {
      start();
      return "running";
    }
    const status = queue.enqueue({
      id,
      provider: session?.provider ?? "unknown",
      bypass: session?.parentSessionId !== undefined,
      start,
    });
    if (status === "queued") {
      cancelHandles.set(id, () => {
        queue.cancel(id);
      });
      mutate(id, (s) => {
        s.lifecycle = { state: "pending_init" };
        delete s.finishedAt;
      });
    }
    return status;
  };
  // attachReport moves the lifecycle to running before calling this, keeping
  // the interrupted run and follow-up handoff atomic to observers. Shifts the
  // head steer off the queue; its settlement launches the next one. Returns
  // false when nothing launches (queue empty, or the agent tore down
  // mid-handoff).
  const launchNextStashedFollowup = (id: string): boolean => {
    // A follow-up must only launch into a live lane. If the session settled
    // or vanished while steers were queued, drop the queue loudly instead of
    // running against a closed agent.
    const live = sessions.get(id);
    if (
      live === undefined ||
      (live.lifecycle.state !== "running" &&
        live.lifecycle.state !== "pending_init")
    ) {
      dropStashedFollowups(id, "session settled");
      runInFlight.delete(id);
      return false;
    }
    const queue = stashedFollowups.get(id);
    const next = queue?.shift();
    if (queue !== undefined && queue.length === 0) stashedFollowups.delete(id);
    if (next === undefined) return false;
    const followup = followupHandles.get(id);
    // The follow-up handle can only be gone if teardown raced the handoff;
    // then no follow-up can inherit the run, so drop the queue loudly and
    // settle instead of leaving wait_agents stuck on a phantom turn.
    if (followup === undefined) {
      const rest = stashedFollowups.get(id);
      if (rest !== undefined) rest.unshift(next);
      else stashedFollowups.set(id, [next]);
      dropStashedFollowups(id, "agent tore down before delivery");
      runInFlight.delete(id);
      return false;
    }
    try {
      next.onStart?.();
    } catch {
      // A throwing onStart must not strand the lane on a phantom turn.
    }
    const pending = followup(next.message);
    void Promise.resolve().then(() => {
      void pending.then(
        (reply) => {
          settleFollowupReply(id, reply, next.onReply);
        },
        (err: unknown) => {
          settleFollowupFailure(id, err, next.failLifecycle, next.onFail);
        },
      );
    });
    return true;
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
      const id =
        input.id !== undefined && input.id.length > 0 ? input.id : createId();
      // Replacing an existing id (e.g. parent reuses a callId) keeps the strip
      // from growing duplicates when a tool call is retried.
      cancelAskInternal(id, "session replaced");
      cancelHandles.delete(id);
      closeHandles.delete(id);
      interruptHandles.delete(id);
      followupHandles.delete(id);
      deliverHandles.delete(id);
      // The old session's queued steers are superseded — surface them.
      dropStashedFollowups(id, "session replaced");
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
        ...(input.parentSessionId !== undefined
          ? { parentSessionId: input.parentSessionId }
          : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.requiresTools !== undefined
          ? { requiresTools: [...input.requiresTools] }
          : {}),
      };
      sessions.set(id, session);
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
              pushEntry(session, {
                kind: "text",
                content: capText(token, maxEntryChars),
              });
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
              pushEntry(session, {
                kind: "thinking",
                content: capText(token, maxEntryChars),
              });
            }
            return;
          }
          case "inference.tool_call.start": {
            const data = event.data as { name?: unknown; callId?: unknown };
            const name = typeof data.name === "string" ? data.name : "tool";
            const callId =
              typeof data.callId === "string"
                ? data.callId
                : `${name}-${session.entries.length}`;
            beginToolCall(session, callId, name, now());
            if (!session.toolNames.includes(name)) session.toolNames.push(name);
            pushEntry(session, { kind: "tool", callId, name, arguments: "" });
            return;
          }
          case "inference.tool_call.delta": {
            const data = event.data as {
              argumentFragment?: unknown;
              callId?: unknown;
            };
            const fragment = data.argumentFragment;
            if (typeof fragment !== "string" || fragment.length === 0) return;
            // Parallel tool calls interleave their deltas; match the owning
            // entry by callId so fragments never attach to a sibling's args.
            const callId = typeof data.callId === "string" ? data.callId : null;
            for (let i = session.entries.length - 1; i >= 0; i--) {
              const entry = session.entries[i];
              if (entry?.kind !== "tool") continue;
              if (callId !== null && entry.callId !== callId) continue;
              entry.arguments = appendCapped(
                entry.arguments,
                fragment,
                maxEntryChars,
              );
              // Preview tracks the same args the transcript holds so the lane
              // and the body never disagree about what is running.
              refreshToolPreview(
                session,
                entry.callId,
                entry.name,
                entry.arguments,
              );
              return;
            }
            return;
          }
          case "inference.tool_call.end": {
            const data = event.data as {
              name?: unknown;
              callId?: unknown;
              arguments?: unknown;
            };
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
              beginToolCall(
                session,
                entry.callId,
                entry.name,
                now(),
                false,
                entry.arguments,
              );
              return;
            }
            // No matching start — record a complete tool entry.
            if (name !== null) {
              const idForEntry = callId ?? `${name}-${session.entries.length}`;
              if (!session.toolNames.includes(name))
                session.toolNames.push(name);
              beginToolCall(
                session,
                idForEntry,
                name,
                now(),
                false,
                args ?? "",
              );
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
                data?: {
                  call?: { name?: unknown; id?: unknown; arguments?: unknown };
                };
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
            // inference-side start already registered it, so leave it.
            if (callId !== null) {
              beginToolCall(session, callId, name, now(), true, rawArgs);
            }
            if (!session.toolNames.includes(name)) session.toolNames.push(name);
            return;
          }
          case "tool.done": {
            const result = (
              event.data as {
                result?: {
                  callId?: unknown;
                  content?: unknown;
                  isError?: unknown;
                };
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
            const content = capText(
              stringifyUnknown(result.content ?? ""),
              maxEntryChars,
            );
            const isError = result.isError === true;
            pushEntry(session, {
              kind: "tool_result",
              callId,
              name,
              content,
              isError,
            });
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
      // run.ts disposes on a salvage return (deadline/cancel) even though it
      // resolves through this same success path — trust "still open,
      // resumable" only when the caller says the agent survived. Defaults
      // true.
      const agentRetained = opts?.agentRetained ?? true;
      // When the original run wins the race against a stashed steer and the
      // session stays open and resumable, deliver the queue as a fresh
      // follow-up instead of dropping it. The lane flips to running in this
      // same mutation so observers never see a completed session with a
      // pending steer.
      let deliverStash = false;
      mutate(id, (session) => {
        // Cancel and interrupt_agent win races: a late complete must not
        // resurrect the session as done. Interrupted is still strip-live
        // (linger), so it needs an explicit check; salvage bodies attach via
        // attachReport without changing state.
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
        if (opts?.stopReason !== undefined)
          session.stopReason = opts.stopReason;
        pushEntry(session, {
          kind: "report",
          content: capText(report, maxEntryChars),
        });
        // A disposed salvage has nothing left for its close handle to do —
        // release it now rather than leaving a stale reference around.
        cancelHandles.delete(id);
        if (!agentRetained) closeHandles.delete(id);
        const pending = stashedFollowups.get(id);
        if (
          pending !== undefined &&
          pending.length > 0 &&
          session.retained === true &&
          followupHandles.has(id)
        ) {
          deliverStash = true;
          session.lifecycle = { state: "running" };
          delete session.finishedAt;
          delete session.stopReason;
          runInFlight.add(id);
        } else {
          runInFlight.delete(id);
        }
        pruneCompleted();
        pruneRetained();
      });
      // A completed turn supersedes any steer still queued — surface it,
      // after the mutate so the completion lands first.
      if (deliverStash && sessions.has(id)) {
        launchNextStashedFollowup(id);
      } else {
        dropStashedFollowups(id, "session completed");
      }
    },

    fail(id: string, error: string): void {
      settleCancelsAsks(id, "session failed");
      mutate(id, (session) => {
        if (
          !isLiveStrip(session.lifecycle) ||
          session.lifecycle.state === "cancelled"
        )
          return;
        // Spawn-path throws already dispose in run.ts's finally; a resumed
        // persisted agent does not, so the live close handle is the only
        // teardown. Invoke it fire-and-forget (same as prune/evict) without
        // marking shutdown — an already-disposed spawn close is idempotent.
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
        // The failure supersedes steers queued behind the failed turn.
        dropStashedFollowups(id, "session failed");
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
        if (session.lifecycle.state === "pending_init")
          session.lifecycle = { state: "running" };
      });
    },

    markRunInFlight(id: string): void {
      if (!sessions.has(id) || runInFlight.has(id)) return;
      runInFlight.add(id);
      bumpRevision(id);
      notify();
    },

    registerClose(
      id: string,
      close: (deadlineMs?: number) => Promise<void>,
    ): void {
      if (!sessions.has(id)) return;
      closeHandles.set(id, close);
      // Wake anything blocked in closeOne's waitForCloseHandle below — a
      // close_agent call that arrived during the agent-setup window waits on
      // this notification instead of reporting false success over an
      // unreleasable session.
      notify();
    },

    async closeOne(
      id: string,
      deadlineMs: number,
    ): Promise<AgentLifecycleStatus> {
      const session = sessions.get(id);
      if (session === undefined) {
        // An id evicted by pruneRetained already had its handles released —
        // close_agent sees that as "already shut down", not a bad id.
        if (evicted.has(id)) return "shutdown";
        return "not_found";
      }
      settleCancelsAsks(id, "session closed");
      // A stashed send_input follow-up must never launch against a closing
      // agent; dropped again in each terminal path below in case the stash
      // lands during the setup-window wait.
      dropStashedFollowups(id, "session closed");
      let close = closeHandles.get(id);
      const alreadyClosed = isAlreadyClosed(session.lifecycle);
      if (alreadyClosed && close === undefined) {
        return projectLifecycleStatus(session.lifecycle);
      }
      if (close === undefined) {
        if (
          session.lifecycle.state === "pending_init" &&
          !runInFlight.has(id)
        ) {
          const abort = cancelHandles.get(id);
          try {
            abort?.();
          } catch {
            // Abort hooks must not throw into the close path.
          }
          mutate(id, (s) => {
            const error = s.error ?? "Closed by close_agent";
            s.lifecycle = { state: "shutdown", error };
            s.retained = false;
            s.finishedAt = s.finishedAt ?? now();
            s.error = error;
          });
          cancelHandles.delete(id);
          interruptHandles.delete(id);
          followupHandles.delete(id);
          deliverHandles.delete(id);
          // Closing supersedes queued steers — surface them.
          dropStashedFollowups(id, "session closed");
          runInFlight.delete(id);
          pruneCompleted();
          return "shutdown";
        }
        // close_agent landed in the setup window — the session exists but
        // registerClose hasn't fired yet. Wait for it (bounded) instead of
        // returning "shutdown" immediately: that used to report false success
        // while leaving the eventual agent unreleasable forever.
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
      const keepFailed = isAlreadyClosed(
        (sessions.get(id) ?? session).lifecycle,
      );
      closeHandles.delete(id);
      // Bounded here too, defense-in-depth against a caller-registered
      // close that does not honor its own deadline argument — a wedged
      // descendant must not hang the whole close_agent call.
      let closeError: unknown;
      try {
        await invokeCloseBounded(close, deadlineMs);
      } catch (err: unknown) {
        closeError = err;
      }
      if (keepFailed) {
        // fail() already stamped failed; invoke leftover teardown without
        // rewriting that to shutdown.
        cancelHandles.delete(id);
        interruptHandles.delete(id);
        followupHandles.delete(id);
        deliverHandles.delete(id);
        // Closing supersedes queued steers — surface them.
        dropStashedFollowups(id, "session closed");
        runInFlight.delete(id);
        pruneCompleted();
        if (closeError !== undefined) throw closeError;
        const after = sessions.get(id);
        return after === undefined
          ? "not_found"
          : projectLifecycleStatus(after.lifecycle);
      }
      mutate(id, (s) => {
        const wasLive = isLiveStrip(s.lifecycle);
        const error =
          s.error ?? (wasLive ? "Closed by close_agent" : undefined);
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
      // Closing supersedes queued steers — surface them.
      dropStashedFollowups(id, "session closed");
      runInFlight.delete(id);
      pruneCompleted();
      if (closeError !== undefined) throw closeError;
      return "shutdown";
    },

    registerInterrupt(id: string, interrupt: () => void): void {
      if (!sessions.has(id)) return;
      interruptHandles.set(id, interrupt);
    },

    registerFollowup(
      id: string,
      followup: (message: string) => Promise<string>,
    ): void {
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
      opts?: {
        interrupt?: boolean;
        onFollowupReply?: (reply: string) => void;
        onStart?: () => void;
        onFail?: (error: unknown) => void;
      },
    ):
      | { ok: true; status: AgentLifecycleStatus }
      | { ok: false; status: AgentLifecycleStatus; hint?: string } {
      const session = sessions.get(id);
      if (session === undefined) {
        // After a stop teardown the id is gone but the teardown is named — a
        // bare `not_found` would read as "never existed" when the real story
        // is "existed, then the runtime shut down".
        const tombstone = evicted.get(id);
        if (tombstone !== undefined) {
          return {
            ok: false,
            status: tombstone.lifecycleStatus,
            hint: tombstone.hint,
          };
        }
        return { ok: false, status: "not_found" };
      }
      if (session.lifecycle.state !== "running") {
        return { ok: false, status: projectLifecycleStatus(session.lifecycle) };
      }

      if (opts?.interrupt === true) {
        const interrupt = interruptHandles.get(id);
        const followup = followupHandles.get(id);
        if (interrupt === undefined || followup === undefined) {
          return {
            ok: false,
            status: projectLifecycleStatus(session.lifecycle),
          };
        }
        settleCancelsAsks(id, "cancelled by send_input interrupt");
        const stashed: StashedFollowup = {
          message,
          failLifecycle: "interrupted",
          ...(opts.onStart !== undefined ? { onStart: opts.onStart } : {}),
          ...(opts.onFollowupReply !== undefined
            ? { onReply: opts.onFollowupReply }
            : {}),
          ...(opts.onFail !== undefined ? { onFail: opts.onFail } : {}),
        };
        // Stash before interrupting because interrupt callbacks may settle
        // the original run synchronously; that terminal transition consumes
        // the stash before control returns here. Overlapping steers queue
        // FIFO; only the first fires the interrupt, later ones ride the
        // already-signalled handoff.
        const queued = stashedFollowups.get(id);
        const opening = queued === undefined;
        if (opening) {
          stashedFollowups.set(id, [stashed]);
        } else {
          queued.push(stashed);
        }
        if (opening) interrupt();
        if (!(stashedFollowups.get(id)?.includes(stashed) ?? false)) {
          const settled = sessions.get(id);
          const status =
            settled === undefined
              ? "not_found"
              : projectLifecycleStatus(settled.lifecycle);
          return {
            ok: true,
            status: status === "running" ? "interrupted" : status,
          };
        }
        mutate(id, (s) => {
          s.stopReason = "interrupted";
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
        /** Grant requestId quoted from the deny reason: binds this ask to
         * its own denial instead of the session's first pending envelope. */
        grantRequestId?: string;
        resolve: (answer: string) => void;
        reject: (reason: unknown) => void;
      },
    ): boolean {
      const session = sessions.get(id);
      if (session === undefined) return false;
      if (session.lifecycle.state !== "running") return false;
      if (pendingAsks.has(id)) return false;
      // Attach the harness-owned denied-call envelope (exact ToolCall + hash)
      // to the ask record, stamping its questionId for the parent's retry
      // ref. A named grantRequestId binds that exact denial; an unnamed ask
      // falls back to the session's first pending envelope.
      let deniedCall: WorkerDeniedCallEnvelope | undefined;
      try {
        deniedCall =
          getProcessWorkerGrantStore().attachToAsk(
            id,
            ask.questionId,
            ask.grantRequestId,
            now(),
          ) ?? undefined;
      } catch {
        // Envelope attach must not fail ask registration.
      }
      pendingAsks.set(
        id,
        deniedCall !== undefined
          ? { ...ask, askedAt: now(), deniedCall }
          : { ...ask, askedAt: now() },
      );
      mutate(id, () => undefined);
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

    peekAsk(id: string):
      | {
          question: string;
          questionId: string;
          deniedCall?: WorkerDeniedCallEnvelope;
        }
      | undefined {
      const pending = pendingAsks.get(id);
      if (pending === undefined) return undefined;
      return {
        question: pending.question,
        questionId: pending.questionId,
        ...(pending.deniedCall !== undefined
          ? { deniedCall: pending.deniedCall }
          : {}),
      };
    },

    expireStaleAsks(
      maxAgeMs: number,
    ): readonly { sessionId: string; questionId: string }[] {
      const cutoff = now() - maxAgeMs;
      const expired: { sessionId: string; questionId: string }[] = [];
      for (const [id, pending] of pendingAsks) {
        if (pending.askedAt > cutoff) continue;
        expired.push({ sessionId: id, questionId: pending.questionId });
        // The parent never answered: the denied-call envelopes fail closed as
        // expired rather than lingering for a later retry. Expire first — the
        // cancel below invalidates only still-pending ones.
        try {
          getProcessWorkerGrantStore().expireSession(
            id,
            `ask ${pending.questionId} expired without an answer`,
          );
        } catch {
          // Expiry marking must not throw into the expiry sweep.
        }
        cancelAskInternal(
          id,
          `ask_director question ${pending.questionId} for session ${id} expired without an answer after ${maxAgeMs}ms — reply with send_input before the deadline, or not at all`,
          true,
        );
      }
      // One subscriber wake for the batch (none when nothing expired):
      // per-ask notifies would wake N observers for one poll tick.
      if (expired.length > 0) notify();
      return expired;
    },

    interruptOne(
      id: string,
    ): { ok: true } | { ok: false; status: AgentLifecycleStatus } {
      const session = sessions.get(id);
      if (session === undefined) return { ok: false, status: "not_found" };
      if (!isLiveStrip(session.lifecycle)) {
        return { ok: false, status: projectLifecycleStatus(session.lifecycle) };
      }
      // interrupt_agent settles the run itself, so a stashed send_input
      // follow-up must not launch from a later attachReport; the dropped
      // steers fail loudly with which message was lost.
      dropStashedFollowups(id, "interrupted by interrupt_agent");
      const interrupt = interruptHandles.get(id);
      if (interrupt === undefined) {
        if (session.lifecycle.state === "pending_init") {
          const abort = cancelHandles.get(id);
          try {
            abort?.();
          } catch {
            // Abort hooks must not throw into the interrupt path.
          }
          // Terminal transition — drop the run-in-flight marker with the
          // lifecycle flip like every other terminal transition, otherwise
          // the wait projection reports "running" forever with no run left
          // to settle it.
          runInFlight.delete(id);
          mutate(id, (s) => {
            s.lifecycle = {
              state: "interrupted",
              ...(s.report !== undefined ? { report: s.report } : {}),
            };
            s.finishedAt = s.finishedAt ?? now();
            s.stopReason = "interrupted";
          });
          pruneRetained();
          return { ok: true };
        }
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
        s.stopReason = "interrupted";
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
      | { ok: true; status: "running" | "queued" }
      | { ok: false; status: AgentLifecycleStatus; hint?: string } {
      const session = sessions.get(id);
      if (session === undefined) {
        const tombstone = evicted.get(id);
        if (tombstone !== undefined) {
          return {
            ok: false,
            status: tombstone.lifecycleStatus,
            hint: tombstone.hint,
          };
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
      const status = queueFollowupTurn(id, message, priorLifecycle, {
        ...(opts?.onStart !== undefined ? { onStart: opts.onStart } : {}),
        ...(opts?.onReply !== undefined ? { onReply: opts.onReply } : {}),
        ...(opts?.onFail !== undefined ? { onFail: opts.onFail } : {}),
      });
      pruneRetained();
      return { ok: true, status };
    },

    cancel(id: string, reason = DEFAULT_CANCEL_REASON): boolean {
      return cancelSession(id, reason);
    },

    async cancelAll(reason = DEFAULT_CANCEL_REASON): Promise<string[]> {
      // Snapshot before cancelSession: markCancelled clears retained, and a
      // resumed retained worker is strip-live so the first loop would
      // otherwise skip the close-handle pass.
      const retainedIds = [...sessions.values()]
        .filter((s) => s.retained === true && s.lifecycle.state !== "shutdown")
        .map((s) => s.id);
      const running = [...sessions.values()].filter((s) =>
        isLiveStrip(s.lifecycle),
      );
      const cancelled: string[] = [];
      for (const session of running) {
        if (cancelSession(session.id, reason)) cancelled.push(session.id);
      }
      const pendingCloses: Promise<void>[] = [];
      for (const id of retainedIds) {
        const session = sessions.get(id);
        if (session === undefined || session.lifecycle.state === "shutdown")
          continue;
        const close = closeHandles.get(id);
        cancelAskInternal(id, "session handles released");
        closeHandles.delete(id);
        cancelHandles.delete(id);
        interruptHandles.delete(id);
        followupHandles.delete(id);
        deliverHandles.delete(id);
        // Releasing supersedes queued steers — surface them.
        dropStashedFollowups(id, "session handles released");
        mutate(id, (s) => {
          s.lifecycle = {
            state: "shutdown",
            ...(s.report !== undefined ? { report: s.report } : {}),
            ...(s.error !== undefined ? { error: s.error } : {}),
          };
          s.retained = false;
        });
        if (close !== undefined) {
          pendingCloses.push(
            invokeCloseBounded(close, DEFAULT_CLOSE_DEADLINE_MS),
          );
        }
      }
      const results = await Promise.allSettled(pendingCloses);
      const failures = results.flatMap((r) =>
        r.status === "rejected" ? [r.reason] : [],
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "session cancelAll close failed");
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

    attachReport(
      id: string,
      report: string,
      opts?: { stopReason?: ForcedStopReason },
    ): void {
      // Consume the head stashed interrupt follow-up before mutating.
      // Interrupted salvage moves directly to the next running turn; any
      // terminal outcome drops the queue loudly so no follow-up runs against
      // a closed agent. Steers behind the head stay queued; each settled
      // follow-up launches the next. Peek here; the launcher shifts after
      // the mutate below.
      const head = stashedFollowups.get(id)?.[0];
      let toLaunch: StashedFollowup | undefined;
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
          if (opts?.stopReason !== undefined)
            session.stopReason = opts.stopReason;
          pushEntry(session, {
            kind: "report",
            content: capText(report, maxEntryChars),
          });
          if (head !== undefined) {
            // Move directly into the follow-up lifecycle before mutate notifies
            // subscribers. No observer can resume the interrupted handoff.
            toLaunch = head;
            session.lifecycle = { state: "running" };
            delete session.finishedAt;
            delete session.stopReason;
          }
        } else if (
          (state === "cancelled" ||
            state === "interrupted" ||
            state === "shutdown") &&
          session.report === undefined
        ) {
          session.report = report;
          session.lifecycle = { ...session.lifecycle, report };
          if (opts?.stopReason !== undefined)
            session.stopReason = opts.stopReason;
          pushEntry(session, {
            kind: "report",
            content: capText(report, maxEntryChars),
          });
        }
        // A launched follow-up inherits the original run's in-flight marker.
        if (toLaunch === undefined) runInFlight.delete(id);
        pruneCompleted();
        pruneRetained();
      });
      if (toLaunch !== undefined && sessions.has(id)) {
        launchNextStashedFollowup(id);
      } else {
        // Terminal outcome (or a session that vanished mid-handoff): nothing
        // launches, so the queued steers are superseded — surface them.
        dropStashedFollowups(id, "session settled");
      }
    },

    isRunInFlight(id: string): boolean {
      return runInFlight.has(id);
    },

    settleRun(id: string): void {
      // Retained run-settle keeps denied-call envelopes (keepGrants): the
      // retained resume_agent retry is the retry path.
      cancelAskInternal(id, "run settled", false, true);
      // The run settled with steers still queued — surface them.
      dropStashedFollowups(id, "run settled");
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
      // Invoke every registered close (best-effort, fire-and-forget) before
      // dropping the maps — this used to drop closeHandles without calling
      // them, leaking every retained session's agent permanently.
      for (const id of pendingAsks.keys())
        cancelAskInternal(id, "store cleared");
      for (const id of closeHandles.keys()) releaseHandles(id);
      cancelHandles.clear();
      closeHandles.clear();
      interruptHandles.clear();
      followupHandles.clear();
      deliverHandles.clear();
      // Surface every queued steer before wiping the map.
      for (const id of stashedFollowups.keys())
        dropStashedFollowups(id, "store cleared");
      stashedFollowups.clear();
      sessions.clear();
      pinCounts.clear();
      runInFlight.clear();
      revisions.clear();
      snapshotCache.clear();
      evicted.clear();
      try {
        getProcessWorkerGrantStore().invalidateAll("store cleared");
      } catch {
        // Grant invalidation must not throw out of clear.
      }
      notify();
    },

    teardown(reason = "Session closed"): void {
      // Stop teardown: cancel asks with the teardown named, release handles
      // like `clear`, then leave a tombstone per session so a late
      // `sendInputOne` fails closed naming the teardown, not `not_found`.
      for (const id of pendingAsks.keys())
        cancelAskInternal(id, `ask_director cancelled: ${reason}`);
      for (const id of closeHandles.keys()) releaseHandles(id);
      cancelHandles.clear();
      closeHandles.clear();
      interruptHandles.clear();
      followupHandles.clear();
      deliverHandles.clear();
      for (const id of stashedFollowups.keys())
        dropStashedFollowups(id, reason);
      stashedFollowups.clear();
      for (const session of sessions.values()) {
        evicted.set(session.id, {
          lifecycleStatus: projectLifecycleStatus(session.lifecycle),
          hint: reason,
        });
      }
      if (evicted.size > MAX_EVICTED_TOMBSTONES) {
        const overflow = evicted.size - MAX_EVICTED_TOMBSTONES;
        const keys = evicted.keys();
        for (let i = 0; i < overflow; i++) {
          const oldest = keys.next().value;
          if (oldest === undefined) break;
          evicted.delete(oldest);
        }
      }
      sessions.clear();
      pinCounts.clear();
      runInFlight.clear();
      revisions.clear();
      snapshotCache.clear();
      try {
        getProcessWorkerGrantStore().invalidateAll(reason);
      } catch {
        // Grant invalidation must not throw out of teardown.
      }
      notify();
    },
  };
}

function cloneSession(
  session: StoredSession,
  inFlight: boolean,
): SubAgentSession {
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
    runInFlight: inFlight,
    ...(session.retained !== undefined ? { retained: session.retained } : {}),
    ...(session.finishedAt !== undefined
      ? { finishedAt: session.finishedAt }
      : {}),
    ...(session.report !== undefined ? { report: session.report } : {}),
    ...(session.error !== undefined ? { error: session.error } : {}),
    ...(session.stopReason !== undefined
      ? { stopReason: session.stopReason }
      : {}),
    ...(session.parentSessionId !== undefined
      ? { parentSessionId: session.parentSessionId }
      : {}),
    ...(session.provider !== undefined ? { provider: session.provider } : {}),
    ...(session.requiresTools !== undefined
      ? { requiresTools: [...session.requiresTools] }
      : {}),
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
