// In-memory registry of sub-agent sessions for TUI inspection.
//
// Parent chat must not receive full child text deltas (that interleaves worker
// prose into the parent turn). Progress stays on the light onProgress channel;
// this store is the dedicated child record the enter-session UI reads.

import type { ReactorEmittedEvent } from "@intx/inference";
import { stopReasonFromReport } from "./report.js";
import { toolCallPreview } from "./tool-preview.js";

export type SubAgentSessionStatus = "running" | "done" | "failed" | "cancelled";

/**
 * CL-6943: lifecycle status surfaced to the parent for the reusable-session
 * verbs (close_agent / resume_agent), independent of `SubAgentSessionStatus`
 * above (which is the older TUI-transcript status and is left alone here).
 * `interrupted` is not produced by anything in this lane — `cancel()` sets
 * it today (the pre-existing operator-cancel path), and the interrupt_agent
 * lane lands later reusing the same value, not a new one.
 */
export type AgentLifecycleStatus =
  "pending_init" | "running" | "interrupted" | "completed" | "shutdown" | "not_found";

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
  status: SubAgentSessionStatus;
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
  finishedAt?: number;
  report?: string;
  error?: string;
  /**
   * Machine-readable termination reason for a forced stop (repetition guard,
   * stall abort, salvage caps, operator cancel) — the report's `Stopped:`
   * line, or `cancelled — <reason>` on cancel. Absent on clean completes.
   */
  stopReason?: string;
  // Session id of the orchestrator that dispatched this worker, when this is
  // a nested (one-hop) dispatch. Undefined for top-level sessions started
  // directly from the primary session's task tool.
  parentSessionId?: string;
  // CL-6943: lifecycle status for the reusable-session verbs. Defaults to
  // "pending_init" until the run wires up markRunning(); see the type doc.
  lifecycleStatus: AgentLifecycleStatus;
  // True when this session's agent is meant to survive a clean completion
  // (spawn_agent opts in). Only a retained session in lifecycleStatus
  // "completed" is exempt from pruneCompleted's cap — once close_agent runs,
  // this flips back to false and the cap applies normally.
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
  // are never pruned by this bound.
  maxCompleted?: number;
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
  // Running + recent completed, newest first — surface for the Agents strip.
  listForStrip(): readonly SubAgentSession[];
  start(input: StartSessionInput): SubAgentSession;
  appendEvent(id: string, event: ReactorEmittedEvent): void;
  complete(id: string, report: string): void;
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
  // Transitions a retained, still-open ("completed") session back to
  // "running" for further input. Fails closed on anything else — a
  // "shutdown" session is gone for good (close_agent is permanent), an
  // "interrupted" one already tore its agent down, and "running"/
  // "pending_init"/"not_found" have nothing to resume.
  resumeOne(id: string): { ok: true } | { ok: false; status: AgentLifecycleStatus };
  subscribe(listener: () => void): () => void;
  clear(): void;
}

export const DEFAULT_CANCEL_REASON = "Cancelled by operator";

const DEFAULT_MAX_COMPLETED = 20;
const DEFAULT_MAX_ENTRIES = 400;
const DEFAULT_MAX_ENTRY_CHARS = 24_000;

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
function syncCurrentTool(session: SubAgentSession): void {
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
  session: SubAgentSession,
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
  session: SubAgentSession,
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
function endToolCall(session: SubAgentSession, callId: string): void {
  const index = session.outstandingTools.findIndex((c) => c.callId === callId);
  if (index === -1) return;
  session.outstandingTools.splice(index, 1);
  syncCurrentTool(session);
}

function clearToolCalls(session: SubAgentSession): void {
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
  const maxCompleted = options.maxCompleted ?? DEFAULT_MAX_COMPLETED;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxEntryChars = options.maxEntryChars ?? DEFAULT_MAX_ENTRY_CHARS;
  const now = options.now ?? (() => Date.now());
  const createId = options.createId ?? defaultCreateId;

  // Insertion order: older first. list() returns a snapshot in that order.
  const sessions = new Map<string, SubAgentSession>();
  // Live abort hooks keyed by session id. Cleared on terminal transition.
  const cancelHandles = new Map<string, () => void>();
  // CL-6943: bounded close functions keyed by session id, for close_agent.
  // Distinct from cancelHandles (a synchronous abort() signal) because
  // closing must be awaitable and bounded by a deadline.
  const closeHandles = new Map<string, (deadlineMs?: number) => Promise<void>>();
  const listeners = new Set<() => void>();

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

  const snapshotOf = (session: SubAgentSession): SubAgentSession => {
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

  const markCancelled = (session: SubAgentSession, reason: string): void => {
    session.status = "cancelled";
    session.lifecycleStatus = "interrupted";
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
    closeHandles.delete(session.id);
    bumpRevision(session.id);
    pruneCompleted();
  };

  const cancelSession = (id: string, reason: string): boolean => {
    const session = sessions.get(id);
    if (session === undefined || session.status !== "running") return false;
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

  const pushEntry = (session: SubAgentSession, entry: SubAgentTranscriptEntry): void => {
    session.entries.push(entry);
    if (session.entries.length > maxEntries) {
      session.entries.splice(0, session.entries.length - maxEntries);
    }
  };

  const pruneCompleted = (): void => {
    if (maxCompleted <= 0) {
      for (const [id, s] of sessions) {
        if (s.status !== "running") {
          sessions.delete(id);
          forgetRevision(id);
        }
      }
      return;
    }
    const finished = [...sessions.values()]
      .filter(
        (s) =>
          s.status !== "running" &&
          // CL-6943: a retained session that is still open ("completed", or
          // "running" again after resume_agent) is reusable and must not be
          // evicted by this display cap out from under it — only a shutdown
          // (or never-retained) finished session counts toward the limit.
          !(
            s.retained === true &&
            (s.lifecycleStatus === "completed" || s.lifecycleStatus === "running")
          ),
      )
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    const excess = finished.length - maxCompleted;
    if (excess <= 0) return;
    for (let i = 0; i < excess; i++) {
      const drop = finished[i];
      if (drop !== undefined) {
        sessions.delete(drop.id);
        forgetRevision(drop.id);
      }
    }
  };

  const mutate = (id: string, fn: (session: SubAgentSession) => void): void => {
    const session = sessions.get(id);
    if (session === undefined) return;
    fn(session);
    session.lastActivityAt = now();
    bumpRevision(id);
    notify();
  };

  return {
    list(): readonly SubAgentSession[] {
      return [...sessions.values()].map(snapshotOf);
    },

    get(id: string): SubAgentSession | undefined {
      const session = sessions.get(id);
      return session === undefined ? undefined : snapshotOf(session);
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
      cancelHandles.delete(id);
      closeHandles.delete(id);
      forgetRevision(id);
      const session: SubAgentSession = {
        id,
        description: input.description,
        agentId: input.agentId,
        brief: input.brief,
        status: "running",
        toolNames: [],
        currentToolName: null,
        currentToolPreview: null,
        currentToolStartedAt: null,
        outstandingTools: [],
        entries: [],
        startedAt: now(),
        lastActivityAt: now(),
        lifecycleStatus: "pending_init",
        ...(input.retained === true ? { retained: true } : {}),
        ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
      };
      sessions.set(id, session);
      bumpRevision(id);
      notify();
      return snapshotOf(session);
    },

    appendEvent(id: string, event: ReactorEmittedEvent): void {
      mutate(id, (session) => {
        if (session.status !== "running") return;
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

    complete(id: string, report: string): void {
      mutate(id, (session) => {
        // Cancel wins races: a late complete after operator cancel must not
        // resurrect the session as done.
        if (session.status !== "running") return;
        session.status = "done";
        // CL-6943: retained sessions stay "completed" (open, reusable) here —
        // only close_agent (closeOne) moves them to "shutdown". A session
        // that never opted into retention has no live agent behind it by the
        // time this fires either way, so the distinction only matters for
        // whether pruneCompleted's cap may evict the record.
        session.lifecycleStatus = "completed";
        session.finishedAt = now();
        clearToolCalls(session);
        session.report = report;
        // A forced-stop salvage arrives via complete(); its Stopped: line is
        // the terminal reason (repetition / stall / salvage caps).
        const stopped = stopReasonFromReport(report);
        if (stopped !== null) session.stopReason = stopped;
        pushEntry(session, { kind: "report", content: capText(report, maxEntryChars) });
        cancelHandles.delete(id);
        pruneCompleted();
      });
    },

    fail(id: string, error: string): void {
      mutate(id, (session) => {
        if (session.status !== "running") return;
        session.status = "failed";
        // A thrown run always tears down its agent in run.ts's finally
        // (persist only skips teardown on a clean success) — so there is
        // nothing left to resume here, and retained no longer applies.
        session.lifecycleStatus = "shutdown";
        session.retained = false;
        session.finishedAt = now();
        clearToolCalls(session);
        session.error = error;
        pushEntry(session, {
          kind: "report",
          content: capText(`Error: ${error}`, maxEntryChars),
        });
        cancelHandles.delete(id);
        closeHandles.delete(id);
        pruneCompleted();
      });
    },

    registerCancel(id: string, abort: () => void): void {
      const session = sessions.get(id);
      if (session === undefined || session.status !== "running") return;
      cancelHandles.set(id, abort);
    },

    markRunning(id: string): void {
      mutate(id, (session) => {
        if (session.lifecycleStatus === "pending_init") session.lifecycleStatus = "running";
      });
    },

    registerClose(id: string, close: (deadlineMs?: number) => Promise<void>): void {
      if (!sessions.has(id)) return;
      closeHandles.set(id, close);
    },

    async closeOne(id: string, deadlineMs: number): Promise<AgentLifecycleStatus> {
      const session = sessions.get(id);
      if (session === undefined) return "not_found";
      if (session.lifecycleStatus === "shutdown") return "shutdown";
      const close = closeHandles.get(id);
      if (close !== undefined) {
        closeHandles.delete(id);
        // Bounded here too, defense-in-depth against a caller-registered
        // close that does not honor its own deadline argument — a wedged
        // descendant must not hang the whole close_agent call.
        await Promise.race([
          close(deadlineMs).catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, deadlineMs)),
        ]);
      }
      mutate(id, (s) => {
        s.lifecycleStatus = "shutdown";
        s.retained = false;
        if (s.status === "running") {
          s.status = "cancelled";
          s.finishedAt = s.finishedAt ?? now();
          s.error = s.error ?? "Closed by close_agent";
        }
      });
      cancelHandles.delete(id);
      pruneCompleted();
      return "shutdown";
    },

    resumeOne(id: string): { ok: true } | { ok: false; status: AgentLifecycleStatus } {
      const session = sessions.get(id);
      if (session === undefined) return { ok: false, status: "not_found" };
      if (session.lifecycleStatus !== "completed" || session.retained !== true) {
        return { ok: false, status: session.lifecycleStatus };
      }
      mutate(id, (s) => {
        s.lifecycleStatus = "running";
      });
      return { ok: true };
    },

    cancel(id: string, reason = DEFAULT_CANCEL_REASON): boolean {
      return cancelSession(id, reason);
    },

    cancelAll(reason = DEFAULT_CANCEL_REASON): string[] {
      const running = [...sessions.values()].filter((s) => s.status === "running");
      const cancelled: string[] = [];
      for (const session of running) {
        if (cancelSession(session.id, reason)) cancelled.push(session.id);
      }
      return cancelled;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    clear(): void {
      // Drop handles without invoking them — callers that need teardown should
      // cancelAll first (parent stop / /clear).
      cancelHandles.clear();
      closeHandles.clear();
      sessions.clear();
      revisions.clear();
      snapshotCache.clear();
      notify();
    },
  };
}

function cloneSession(session: SubAgentSession): SubAgentSession {
  return {
    id: session.id,
    description: session.description,
    agentId: session.agentId,
    brief: session.brief,
    status: session.status,
    toolNames: [...session.toolNames],
    currentToolName: session.currentToolName,
    currentToolPreview: session.currentToolPreview,
    currentToolStartedAt: session.currentToolStartedAt,
    outstandingTools: session.outstandingTools.map((c) => ({ ...c })),
    entries: session.entries.map(cloneEntry),
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    lifecycleStatus: session.lifecycleStatus,
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
