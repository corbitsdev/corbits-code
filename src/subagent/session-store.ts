// In-memory registry of sub-agent sessions for TUI inspection.
//
// Parent chat must not receive full child text deltas (that interleaves worker
// prose into the parent turn). Progress stays on the light onProgress channel;
// this store is the dedicated child record the enter-session UI reads.

import type { ReactorEmittedEvent } from "@intx/inference";

export type SubAgentSessionStatus = "running" | "done" | "failed" | "cancelled";

// Compact transcript entries suitable for TUI render without depending on the
// TUI ContentBlock type (keeps subagent free of a reverse dependency on tui/).
export type SubAgentTranscriptEntry =
  | { kind: "text"; content: string }
  | { kind: "thinking"; content: string }
  | { kind: "tool"; callId: string; name: string; arguments: string }
  | { kind: "tool_result"; callId: string; name: string; content: string; isError: boolean }
  | { kind: "report"; content: string };

export type SubAgentSession = {
  id: string;
  description: string;
  agentId: string;
  brief: string;
  status: SubAgentSessionStatus;
  toolNames: string[];
  currentToolName: string | null;
  entries: SubAgentTranscriptEntry[];
  startedAt: number;
  finishedAt?: number;
  report?: string;
  error?: string;
  // Session id of the orchestrator that dispatched this worker, when this is
  // a nested (one-hop) dispatch. Undefined for top-level sessions started
  // directly from the primary session's task tool.
  parentSessionId?: string;
};

export type StartSessionInput = {
  description: string;
  agentId: string;
  brief: string;
  // Optional external id (e.g. parent tool callId) so the Agents strip can
  // correlate progress with the session. Generated when omitted.
  id?: string;
  // Set when this session is a nested dispatch spawned by an orchestrator
  // sub-agent, so the strip can render it indented under its parent.
  parentSessionId?: string;
};

export type SubAgentSessionStoreOptions = {
  // Cap on completed/failed sessions retained after finish. Running sessions
  // are never pruned by this bound.
  maxCompleted?: number;
  // Cap on transcript entries per session (oldest dropped).
  maxEntries?: number;
  // Cap on characters per text/thinking/result entry.
  maxEntryChars?: number;
  now?: () => number;
  createId?: () => string;
};

export type SubAgentSessionStore = {
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
  subscribe(listener: () => void): () => void;
  clear(): void;
};

const DEFAULT_MAX_COMPLETED = 20;
const DEFAULT_MAX_ENTRIES = 400;
const DEFAULT_MAX_ENTRY_CHARS = 24_000;

let nextId = 0;
function defaultCreateId(): string {
  nextId += 1;
  return `subagent-${nextId}`;
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
    session.finishedAt = now();
    session.currentToolName = null;
    session.error = reason;
    pushEntry(session, {
      kind: "report",
      content: capText(`Cancelled: ${reason}`, maxEntryChars),
    });
    cancelHandles.delete(session.id);
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
      .filter((s) => s.status !== "running")
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
      return [...sessions.values()]
        .map(snapshotOf)
        .sort((a, b) => {
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
      forgetRevision(id);
      const session: SubAgentSession = {
        id,
        description: input.description,
        agentId: input.agentId,
        brief: input.brief,
        status: "running",
        toolNames: [],
        currentToolName: null,
        entries: [],
        startedAt: now(),
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
            const callId = typeof data.callId === "string" ? data.callId : `${name}-${session.entries.length}`;
            session.currentToolName = name;
            session.toolNames.push(name);
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
              session.currentToolName = entry.name;
              return;
            }
            // No matching start — record a complete tool entry.
            if (name !== null) {
              const idForEntry = callId ?? `${name}-${session.entries.length}`;
              if (!session.toolNames.includes(name)) session.toolNames.push(name);
              session.currentToolName = name;
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
            const call = (event as { data?: { call?: { name?: unknown; id?: unknown } } }).data?.call;
            const name = typeof call?.name === "string" ? call.name : null;
            if (name === null) return;
            session.currentToolName = name;
            if (!session.toolNames.includes(name)) session.toolNames.push(name);
            return;
          }
          case "tool.done": {
            const result = (event.data as {
              result?: { callId?: unknown; content?: unknown; isError?: unknown };
            })?.result;
            if (result === undefined) return;
            const callId = typeof result.callId === "string" ? result.callId : `result-${session.entries.length}`;
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
            session.currentToolName = null;
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
        session.finishedAt = now();
        session.currentToolName = null;
        session.report = report;
        pushEntry(session, { kind: "report", content: capText(report, maxEntryChars) });
        cancelHandles.delete(id);
        pruneCompleted();
      });
    },

    fail(id: string, error: string): void {
      mutate(id, (session) => {
        if (session.status !== "running") return;
        session.status = "failed";
        session.finishedAt = now();
        session.currentToolName = null;
        session.error = error;
        pushEntry(session, {
          kind: "report",
          content: capText(`Error: ${error}`, maxEntryChars),
        });
        cancelHandles.delete(id);
        pruneCompleted();
      });
    },

    registerCancel(id: string, abort: () => void): void {
      const session = sessions.get(id);
      if (session === undefined || session.status !== "running") return;
      cancelHandles.set(id, abort);
    },

    cancel(id: string, reason = "Cancelled by operator"): boolean {
      return cancelSession(id, reason);
    },

    cancelAll(reason = "Cancelled by operator"): string[] {
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
    entries: session.entries.map(cloneEntry),
    startedAt: session.startedAt,
    ...(session.finishedAt !== undefined ? { finishedAt: session.finishedAt } : {}),
    ...(session.report !== undefined ? { report: session.report } : {}),
    ...(session.error !== undefined ? { error: session.error } : {}),
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
