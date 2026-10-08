/**
 * Turn phase folded from the session event stream (no React hook holds
 * stream state). Feeds the progress label, quota auto-retry, and stall
 * watchdog. Pure: transitions take `nowMs` from the caller.
 */

import { type } from "arktype";

import { isReactorErrorFatal } from "../agent/reactor-events.js";
import type { TurnStatus } from "./chrome-state.js";

// Cap on accumulated stream text per cycle; comfortably above the
// fingerprint's need.
const STREAM_TEXT_BUFFER_CHARS = 8_000;

// Skip cycles shorter than this when updating the streak — a bare tool call
// or one-word aside is too little signal, and short matches are common
// coincidences; skipping neither breaks nor extends a streak.
const CYCLE_FINGERPRINT_MIN_CHARS = 24;

// Consecutive identical cycle fingerprints before the run counts as a loop.
// The bar sits above the verified false positive (the same short line before
// each of 9-12 tool calls must not abort) and below the repro (an unvarying
// 46-char block for 500 cycles). Residual exposure: an invariant line of at
// least `CYCLE_FINGERPRINT_MIN_CHARS` chars repeated verbatim.
const CYCLE_REPETITION_MIN_CONSECUTIVE = 20;

/**
 * FNV-1a fingerprint of a completed cycle's text; the streak stores this
 * short string, not raw text — raw retention caused the false positive
 * this replaces.
 */
function cycleFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export interface QuotaWait {
  readonly retryAfterMs: number;
  readonly retryAt: number;
}

export interface TurnState {
  readonly status: TurnStatus;
  readonly isProcessing: boolean;
  /** Between a request and its first streamed token. */
  readonly awaitingResponse: boolean;
  readonly streamingType: "text" | "thinking" | "tool" | null;
  readonly currentToolName: string | null;
  /** Text deltas seen this turn — the only live count (usage totals land on
   * `inference.done`). Counts events, not real tokens: a proxy for
   * arrival. */
  readonly streamTokenCount: number;
  readonly lastActivityAt: number;
  /** Set while a provider rate limit is cooling down. */
  readonly quota: QuotaWait | null;
  /** Tool calls of the current cycle with no result yet. A reply closes the
   * cycle, not the turn, while tools are out; settling needs the outstanding
   * ids, not just the last name. */
  readonly activeToolCalls: readonly string[];
  /** Real id per tool name once seen this turn; a name-only announcement and
   * the later id-bearing tool.start collapse onto one `activeToolCalls`
   * entry. */
  readonly callIdByName: Readonly<Record<string, string>>;
  /** Tool name per in-flight real call id, so same-name calls keep separate
   * records. `callIdByName` holds only the latest id per name; resolving it
   * would orphan the sibling — and a stall-bounded poll like `wait_agents`
   * its stall budget. */
  readonly callNameById: Readonly<Record<string, string>>;
  /** Tail of text/thinking streamed in the current uninterrupted cycle; a
   * tool call ends the cycle and clears it, so short narration between calls
   * cannot accumulate into a loop. Bounded to `STREAM_TEXT_BUFFER_CHARS`;
   * feeds only the fingerprint comparison in `runningTool`. */
  readonly streamText: string;
  /** True once `consecutiveMatchingCycles` has crossed its threshold this
   * turn. */
  readonly repeating: boolean;
  /** `streamTokenCount` when repetition was first observed; latched so the
   * abort reports tokens spent looping, not the whole turn's count. */
  readonly repeatingSinceTokenCount: number | null;
  /** Fingerprint of the last completed cycle (set at each tool-call
   * boundary), compared against the next; keeping raw text made repeats
   * accumulate into a false positive. */
  readonly cycleFingerprint: string | null;
  /** Consecutive completed cycles whose fingerprint matched the previous
   * one; a model repeating the same block between tool calls builds it. */
  readonly consecutiveMatchingCycles: number;
  /** Outstanding approval/operator gates (queued or on screen). Above zero
   * reads "blocked" and exempts the turn from the stall watchdog: an
   * operator reading a prompt must look live to the silence clock. Painter
   * and watchdog share it. */
  readonly blockedGateCount: number;
}

export function initialTurnState(nowMs: number): TurnState {
  return {
    status: "idle",
    isProcessing: false,
    awaitingResponse: false,
    streamingType: null,
    currentToolName: null,
    streamTokenCount: 0,
    lastActivityAt: nowMs,
    quota: null,
    activeToolCalls: [],
    callIdByName: {},
    callNameById: {},
    streamText: "",
    repeating: false,
    repeatingSinceTokenCount: null,
    cycleFingerprint: null,
    consecutiveMatchingCycles: 0,
    blockedGateCount: 0,
  };
}

/**
 * Reset to a fresh turn state but carry the outstanding gate count across
 * the boundary — dropping it would let the eventual `turnStateGateClosed`
 * decrement an unrelated later turn. The reset status is left as given;
 * relabeling `"blocked"` could let a later gate-close revive the turn.
 */
function carryBlockedGateCount(prior: TurnState, fresh: TurnState): TurnState {
  return prior.blockedGateCount === 0
    ? fresh
    : { ...fresh, blockedGateCount: prior.blockedGateCount };
}

/** Operator submitted a prompt: the run is live and awaiting first tokens. */
export function turnStateOnSubmit(state: TurnState, nowMs: number): TurnState {
  return {
    ...state,
    // A gate left over from a prior turn still blocks the operator, so the
    // new turn inherits the exemption too.
    status: state.blockedGateCount > 0 ? "blocked" : "running",
    isProcessing: true,
    awaitingResponse: true,
    streamingType: null,
    currentToolName: null,
    streamTokenCount: 0,
    lastActivityAt: nowMs,
    activeToolCalls: [],
    callIdByName: {},
    callNameById: {},
    streamText: "",
    repeating: false,
    repeatingSinceTokenCount: null,
    cycleFingerprint: null,
    consecutiveMatchingCycles: 0,
  };
}

/** Ctrl+C / watchdog abort: nothing is in flight and no prompt may be
 * replayed. */
export function turnStateOnInterrupt(
  state: TurnState,
  nowMs: number,
): TurnState {
  return carryBlockedGateCount(state, {
    ...initialTurnState(nowMs),
    status: "stopped",
  });
}

/**
 * Stall layer of a hung running turn, for the stall-bound abort. The record
 * cannot tell "never started" from "went quiet mid-stream"; phase markers
 * can: tool turns keep `activeToolCalls` (or `streamingType: "tool"`) and
 * are left alone; awaiting its first token, or mid-stream with no tools
 * out, is the inference layer hanging.
 */
export function turnStallLayer(
  state: TurnState,
): "awaiting-first-token" | "mid-stream" | "tool-execution" | null {
  if (state.status !== "running") return null;
  if (state.activeToolCalls.length > 0 || state.streamingType === "tool") {
    return "tool-execution";
  }
  if (state.awaitingResponse && state.streamingType === null) {
    return "awaiting-first-token";
  }
  return "mid-stream";
}

/** A gate was raised — queued or opened, the turn does not distinguish.
 * The first outstanding gate blocks the turn without ending it; further
 * gates add to the count until all clear. */
export function turnStateGateOpened(state: TurnState): TurnState {
  const blockedGateCount = state.blockedGateCount + 1;
  return {
    ...state,
    status: "blocked",
    blockedGateCount,
  };
}

/** A gate resolved; the last one clears the block — "running" if
 * processing, else "idle". `lastActivityAt` moves to `nowMs` so the stall
 * clock restarts from the answer, not from silence. */
export function turnStateGateClosed(
  state: TurnState,
  nowMs: number,
): TurnState {
  const blockedGateCount = Math.max(0, state.blockedGateCount - 1);
  if (blockedGateCount > 0) return { ...state, blockedGateCount };
  return {
    ...state,
    status:
      state.status === "blocked"
        ? state.isProcessing
          ? "running"
          : "idle"
        : state.status,
    lastActivityAt: nowMs,
    blockedGateCount,
  };
}

export function clearQuotaWait(state: TurnState): TurnState {
  return state.quota === null ? state : { ...state, quota: null };
}

const inferenceErrorData = type({
  error: {
    category: "string",
    "retryAfterMs?": "number",
  },
});

const tokenData = type({ "token?": "string" });

/**
 * Text carried by a delta event: `data.token` in reactor shapes, top-level
 * `text` in canonical bridge shapes.
 */
function deltaText(event: {
  readonly data?: unknown;
  readonly text?: string;
}): string {
  const parsed = tokenData(event.data);
  if (!(parsed instanceof type.errors) && parsed.token !== undefined) {
    return parsed.token;
  }
  return event.text ?? "";
}

function quotaFromInferenceError(
  data: unknown,
  nowMs: number,
): QuotaWait | null {
  const parsed = inferenceErrorData(data);
  if (parsed instanceof type.errors) return null;
  const { category, retryAfterMs } = parsed.error;
  if (category !== "quota_exhausted" || retryAfterMs === undefined) return null;
  return { retryAfterMs, retryAt: nowMs + retryAfterMs };
}

interface CallIdentity {
  readonly id?: string;
  readonly name?: string;
}

// Parse both streamed shapes — flat (`{ callId?, name? }`) and nested
// tool.start (`{ call: { id?, callId?, name? } }`) — so identity
// bookkeeping reads one parse instead of two schemas that could drift.
const callEventData = type({
  "callId?": "string",
  "name?": "string",
  "call?": { "id?": "string", "callId?": "string", "name?": "string" },
});

function streamedCallIdentity(data: unknown): CallIdentity {
  const parsed = callEventData(data);
  if (parsed instanceof type.errors) return {};
  const id = parsed.callId ?? parsed.call?.id ?? parsed.call?.callId;
  const name = parsed.name ?? parsed.call?.name;
  return {
    ...(id !== undefined ? { id } : {}),
    ...(name !== undefined ? { name } : {}),
  };
}

function toolName(data: unknown): string | null {
  return streamedCallIdentity(data).name ?? null;
}

const toolDoneData = type({
  result: { "callId?": "string", "name?": "string" },
});

function resultIdentity(data: unknown): CallIdentity {
  const parsed = toolDoneData(data);
  if (parsed instanceof type.errors) return {};
  const { callId, name } = parsed.result;
  return {
    ...(callId !== undefined ? { id: callId } : {}),
    ...(name !== undefined ? { name } : {}),
  };
}

function withActiveCall(
  active: readonly string[],
  id: string,
): readonly string[] {
  return active.includes(id) ? active : [...active, id];
}

/**
 * Drop one outstanding call; an unmatched id still consumes an entry, or a
 * mismatched pair would leave the turn permanently "working".
 */
function withoutActiveCall(
  active: readonly string[],
  id: string,
): readonly string[] {
  const index = active.indexOf(id);
  if (index !== -1) return active.filter((_, i) => i !== index);
  return active.slice(1);
}

interface CallTracking {
  readonly activeToolCalls: readonly string[];
  /** Real id per tool name once seen; same-name calls still collide until
   * both have real ids. */
  readonly callIdByName: Readonly<Record<string, string>>;
  /** Tool name per in-flight real call id, so same-name siblings do not
   * overwrite each other. */
  readonly callNameById: Readonly<Record<string, string>>;
}

function withoutCallNameById(
  callNameById: Readonly<Record<string, string>>,
  id: string,
): Readonly<Record<string, string>> {
  if (!(id in callNameById)) return callNameById;
  return Object.fromEntries(
    Object.entries(callNameById).filter(([callId]) => callId !== id),
  );
}

/**
 * Canonicalize one call's identity at the event boundary: a name-only
 * announcement and the later id-bearing event for the same call must
 * collapse onto one entry, not two.
 */
function registerActiveCall(
  tracking: CallTracking,
  identity: CallIdentity,
): CallTracking {
  const { activeToolCalls, callIdByName, callNameById } = tracking;

  if (identity.id !== undefined) {
    const nextCallIdByName =
      identity.name !== undefined
        ? { ...callIdByName, [identity.name]: identity.id }
        : callIdByName;
    const nextCallNameById =
      identity.name !== undefined
        ? { ...callNameById, [identity.id]: identity.name }
        : callNameById;
    // A provisional entry may already track this call under its name —
    // promote it onto the real id instead of adding a duplicate.
    const withoutPlaceholder =
      identity.name !== undefined && activeToolCalls.includes(identity.name)
        ? activeToolCalls.filter((c) => c !== identity.name)
        : activeToolCalls;
    return {
      activeToolCalls: withActiveCall(withoutPlaceholder, identity.id),
      callIdByName: nextCallIdByName,
      callNameById: nextCallNameById,
    };
  }

  if (identity.name !== undefined) {
    const id = callIdByName[identity.name] ?? identity.name;
    return {
      activeToolCalls: withActiveCall(activeToolCalls, id),
      callIdByName,
      callNameById,
    };
  }

  return {
    activeToolCalls: withActiveCall(activeToolCalls, "tool"),
    callIdByName,
    callNameById,
  };
}

function withoutCallIdByName(
  callIdByName: Readonly<Record<string, string>>,
  name: string,
): Readonly<Record<string, string>> {
  if (!(name in callIdByName)) return callIdByName;
  return Object.fromEntries(
    Object.entries(callIdByName).filter(([n]) => n !== name),
  );
}

/** Map an id back to its tool name — tool.done rarely carries the name, so
 * this is the only way to clear a finished call's entry without the result
 * payload. */
function nameForCallId(
  callIdByName: Readonly<Record<string, string>>,
  id: string,
): string | undefined {
  return Object.entries(callIdByName).find(([, v]) => v === id)?.[0];
}

function unregisterActiveCall(
  tracking: CallTracking,
  identity: CallIdentity,
): CallTracking {
  const { activeToolCalls, callIdByName, callNameById } = tracking;

  if (identity.id !== undefined) {
    // Clear the mapping when the call resolves, or a later call reusing the
    // name would resolve to this finished id. The per-id record clears only
    // that entry, so a same-name sibling keeps its name.
    const resolvedName =
      identity.name ?? nameForCallId(callIdByName, identity.id);
    const nextCallIdByName =
      resolvedName !== undefined
        ? withoutCallIdByName(callIdByName, resolvedName)
        : callIdByName;
    return {
      activeToolCalls: withoutActiveCall(activeToolCalls, identity.id),
      callIdByName: nextCallIdByName,
      callNameById: withoutCallNameById(callNameById, identity.id),
    };
  }

  if (identity.name !== undefined) {
    const id = callIdByName[identity.name] ?? identity.name;
    return {
      activeToolCalls: withoutActiveCall(activeToolCalls, id),
      callIdByName: withoutCallIdByName(callIdByName, identity.name),
      callNameById: withoutCallNameById(callNameById, id),
    };
  }

  return {
    activeToolCalls: withoutActiveCall(activeToolCalls, "tool"),
    callIdByName,
    callNameById,
  };
}

const streaming = (
  state: TurnState,
  kind: "text" | "thinking",
  nowMs: number,
  text: string,
): TurnState => {
  const streamTokenCount =
    kind === "text" ? state.streamTokenCount + 1 : state.streamTokenCount;
  const streamText = `${state.streamText}${text}`.slice(
    -STREAM_TEXT_BUFFER_CHARS,
  );
  return {
    ...state,
    status: state.status === "blocked" ? "blocked" : "running",
    isProcessing: true,
    awaitingResponse: false,
    streamingType: kind,
    streamTokenCount,
    lastActivityAt: nowMs,
    streamText,
  };
};

// A tool call ends the streaming cycle; the buffer is discarded here — not
// only on a fresh turn — so repeats cannot accumulate across
// `connector.reply` boundaries. Discarding outright would miss a real loop
// interleaving a tool call between repeats, so a fingerprint of the
// completed cycle is kept and compared against the next.
const runningTool = (
  state: TurnState,
  name: string | null,
  nowMs: number,
): TurnState => {
  const cycleText = state.streamText;
  const longEnoughToCompare = cycleText.length >= CYCLE_FINGERPRINT_MIN_CHARS;
  const fingerprint = longEnoughToCompare ? cycleFingerprint(cycleText) : null;
  const matchedPrevious =
    longEnoughToCompare &&
    state.cycleFingerprint !== null &&
    fingerprint === state.cycleFingerprint;
  const consecutiveMatchingCycles = matchedPrevious
    ? state.consecutiveMatchingCycles + 1
    : longEnoughToCompare
      ? 1
      : state.consecutiveMatchingCycles;
  const repeating =
    state.repeating ||
    consecutiveMatchingCycles >= CYCLE_REPETITION_MIN_CONSECUTIVE;

  return {
    ...state,
    status: state.status === "blocked" ? "blocked" : "running",
    isProcessing: true,
    awaitingResponse: false,
    streamingType: "tool",
    currentToolName: name ?? state.currentToolName,
    lastActivityAt: nowMs,
    streamText: "",
    repeating,
    repeatingSinceTokenCount:
      repeating && state.repeatingSinceTokenCount === null
        ? state.streamTokenCount
        : state.repeatingSinceTokenCount,
    cycleFingerprint: longEnoughToCompare
      ? fingerprint
      : state.cycleFingerprint,
    consecutiveMatchingCycles,
  };
};

/**
 * Fold one inbound event (reactor-shaped or canonical bridge-shaped) into the
 * turn state. Unknown types leave the state untouched.
 */
export function turnStateFromEvent(
  state: TurnState,
  event: {
    readonly type: string;
    readonly data?: unknown;
    /** Canonical bridge shapes carry these instead of `data`. */
    readonly state?: string;
    readonly name?: string;
    readonly text?: string;
  },
  nowMs: number,
): TurnState {
  switch (event.type) {
    case "message.received":
      return turnStateOnSubmit(state, nowMs);

    case "inference.start":
      return {
        ...state,
        status: state.status === "blocked" ? "blocked" : "running",
        isProcessing: true,
        awaitingResponse: true,
        streamingType: null,
        currentToolName: null,
        lastActivityAt: nowMs,
      };

    case "inference.text.delta":
    case "assistant.delta":
      return streaming(state, "text", nowMs, deltaText(event));

    case "inference.thinking.delta":
    case "thinking.delta":
      return streaming(state, "thinking", nowMs, deltaText(event));

    case "inference.tool_call.delta":
      return runningTool(state, toolName(event.data), nowMs);

    case "inference.tool_call.start":
    case "inference.tool_call.end":
    case "tool.start": {
      const identity = streamedCallIdentity(event.data);
      const running = runningTool(state, identity.name ?? null, nowMs);
      const tracking = registerActiveCall(running, identity);
      return { ...running, ...tracking };
    }

    case "tool_call": {
      const running = runningTool(state, event.name ?? null, nowMs);
      return {
        ...running,
        activeToolCalls: withActiveCall(
          state.activeToolCalls,
          event.name ?? "tool",
        ),
      };
    }

    // Tool finished; the model is called again, so the awaiting-response
    // clock restarts rather than the tool clock continuing.
    case "tool.done": {
      const tracking = unregisterActiveCall(state, resultIdentity(event.data));
      return {
        ...state,
        ...tracking,
        awaitingResponse: tracking.activeToolCalls.length === 0,
        streamingType: null,
        currentToolName: null,
        lastActivityAt: nowMs,
      };
    }

    case "tool_result": {
      const activeToolCalls = withoutActiveCall(
        state.activeToolCalls,
        event.name ?? "tool",
      );
      return {
        ...state,
        awaitingResponse: activeToolCalls.length === 0,
        streamingType: null,
        currentToolName: null,
        lastActivityAt: nowMs,
        activeToolCalls,
      };
    }

    /** Also terminates the turn with no tool calls outstanding:
     * `connector.reply` is the usual signal, but a self-continuing workflow
     * cycle may never emit one, so without settling here the phase line
     * stays hot. A cycle that just requested tools ends only here — those
     * calls are in `activeToolCalls`. */
    case "inference.done":
      if (state.activeToolCalls.length > 0) {
        return {
          ...state,
          awaitingResponse: false,
          streamingType: null,
          lastActivityAt: nowMs,
        };
      }
      return carryBlockedGateCount(state, {
        ...initialTurnState(nowMs),
        status: "done",
        quota: state.quota,
      });

    /** The other turn terminator: `agent.send()` resolves on connector.reply,
     * a beat after `inference.done` settled the turn, so this is an
     * idempotent re-settle. A reply with tools still outstanding only ends
     * the cycle, not the turn. */
    case "connector.reply":
      if (state.activeToolCalls.length > 0) {
        return { ...state, awaitingResponse: false, lastActivityAt: nowMs };
      }
      return carryBlockedGateCount(state, {
        ...initialTurnState(nowMs),
        status: "done",
        quota: state.quota,
      });

    case "inference.error": {
      const quota = quotaFromInferenceError(event.data, nowMs);
      return {
        ...state,
        lastActivityAt: nowMs,
        ...(quota !== null ? { quota } : {}),
      };
    }

    case "reactor.done":
      return carryBlockedGateCount(state, {
        ...initialTurnState(nowMs),
        quota: state.quota,
      });

    case "reactor.error":
      if (!isReactorErrorFatal(event.data)) return state;
      return carryBlockedGateCount(state, {
        ...initialTurnState(nowMs),
        status: "failed",
      });

    case "run":
      return event.state === "busy"
        ? turnStateOnSubmit(state, nowMs)
        : carryBlockedGateCount(state, {
            ...initialTurnState(nowMs),
            quota: state.quota,
          });

    default:
      return state;
  }
}
