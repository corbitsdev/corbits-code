/**
 * Live turn phase derived from the session event stream.
 *
 * The OpenTUI shell has no React hook holding stream state, so the bridge folds
 * the same events the transcript paints into this small record. It feeds the
 * progress label, the quota auto-retry decision, and the stall watchdog — all
 * three need the phase, the last-activity clock, and the rate-limit window.
 *
 * Pure and clock-injected: every transition takes `nowMs` from the caller.
 */

import { type } from "arktype";

import type { TurnStatus } from "./session-chrome.js";

// Bound on the accumulated stream text kept for the current cycle. Comfortably
// larger than what the cross-cycle fingerprint comparison needs.
const STREAM_TEXT_BUFFER_CHARS = 8_000;

// Cycles shorter than this are skipped when updating the cross-cycle streak:
// a bare tool call with no preceding text, or a one-word aside, is too little
// signal to compare — matching by coincidence is common at this length, and
// skipping neither breaks nor extends a streak already in progress.
const CYCLE_FINGERPRINT_MIN_CHARS = 24;

// How many consecutive cycles must fingerprint identically before it counts
// as a loop rather than ordinary phrasing. The fingerprint covers the whole
// cycle's text, so any variation at all — a changing filename, index, or
// detail ("Editing src/module_47.ts next.") produces a different hash and
// never advances the streak, no matter how many cycles run. That is what
// makes this bar tolerable at a bare-number glance: it only ever governs
// content that is byte-for-byte invariant, cycle after cycle, which ordinary
// narration is not. The verified false positive (CL-5577) is a model saying
// the exact same short line before each of 9-12 separate tool calls in one
// turn — that must not abort, so the bar sits above that range with
// headroom. Set well below the reported repro (an unvarying 46-char block
// repeated every cycle for 500 cycles, which the unconditional-reset version
// never caught at all): at this bar the streak still trips a small fraction
// of the way in, a few thousand characters and under two dozen tool calls,
// not after 500 and 88,000 characters. The remaining exposure is narrow and
// explicit: an exact, invariant line of at least `CYCLE_FINGERPRINT_MIN_CHARS`
// chars repeated with zero variation for this many cycles running straight
// through tool calls — contentless boilerplate, not narration.
const CYCLE_REPETITION_MIN_CONSECUTIVE = 20;

/**
 * Cheap 32-bit fingerprint (FNV-1a) of one completed cycle's text, so the
 * cross-cycle streak only has to remember a short string per turn rather than
 * retain raw text across cycles — the retained text is exactly what caused
 * the cross-cycle false positive this replaces.
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
  /**
   * Text deltas seen so far this turn — the only live count available: usage
   * totals only land on `inference.done`, well after the turn has finished
   * streaming. Counts delta events, not a real tokenizer, so it is a proxy
   * for "how much has arrived" rather than an exact token count.
   */
  readonly streamTokenCount: number;
  readonly lastActivityAt: number;
  /** Set while a provider rate limit is cooling down. */
  readonly quota: QuotaWait | null;
  /**
   * Tool calls streamed by the current cycle that have not reported a result.
   * `connector.reply` closes a cycle but not the turn when tools are still out,
   * so the settle decision needs the outstanding ids, not just the last name.
   */
  readonly activeToolCalls: readonly string[];
  /**
   * Real id for a tool name once one has been seen this turn, so a
   * name-only announcement and its later id-bearing counterpart collapse
   * onto one `activeToolCalls` entry. See `registerActiveCall`.
   */
  readonly callIdByName: Readonly<Record<string, string>>;
  /**
   * Tail of the text/thinking output streamed in the current uninterrupted
   * streaming cycle. A tool call ends the cycle and clears it: a model
   * narrating a similar short line before each of several tool calls is
   * ordinary and must not accumulate into an apparent loop. Bounded to
   * `STREAM_TEXT_BUFFER_CHARS`; feeds the cross-cycle fingerprint comparison
   * in `runningTool`, nothing else.
   */
  readonly streamText: string;
  /** True once `consecutiveMatchingCycles` has crossed its threshold this turn. */
  readonly repeating: boolean;
  /**
   * `streamTokenCount` at the moment repetition was first observed this turn.
   * Latched, not recomputed, so the abort can report tokens spent looping
   * rather than the whole turn's count.
   */
  readonly repeatingSinceTokenCount: number | null;
  /**
   * Fingerprint of the most recently completed streaming cycle (set at each
   * tool-call boundary), used only to compare against the next cycle's
   * fingerprint. Not the raw text — carrying that across cycles is what
   * caused repeats to accumulate into a false positive across tool calls.
   */
  readonly cycleFingerprint: string | null;
  /**
   * Consecutive completed cycles whose fingerprint matched the one before it.
   * A model repeating the same block every cycle, with a tool call in
   * between each, builds this streak on its own.
   */
  readonly consecutiveMatchingCycles: number;
  /**
   * Outstanding approval/operator gates, counted from the moment each is
   * raised — queued behind another overlay or already on screen, both count.
   * `status` reads "blocked" whenever this is above zero, which is what
   * exempts the turn from the stall watchdog: an operator reading a prompt
   * must be indistinguishable from a live tool call as far as the silence
   * clock is concerned. Painter and watchdog both read this one field rather
   * than each re-deriving blocked-ness from the shell's overlay.
   */
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
    streamText: "",
    repeating: false,
    repeatingSinceTokenCount: null,
    cycleFingerprint: null,
    consecutiveMatchingCycles: 0,
    blockedGateCount: 0,
  };
}

/**
 * Reset to a fresh turn state, except an outstanding gate's count carries
 * across the boundary rather than being dropped. Interrupting or settling a
 * turn does not close the permission/operator overlay still on screen —
 * nothing else resolves it — so losing count of it here would let its
 * eventual `turnStateGateClosed` decrement an unrelated later turn's count
 * instead, either dropping that turn's own exemption early or masking a
 * stall it never earned. The status this resets to (`"stopped"`, `"done"`,
 * ...) is left as given: every one of those is already `!== "running"`,
 * which is all the watchdog requires, so there is no need to relabel it
 * `"blocked"` and risk `turnStateGateClosed` later reviving it to `"running"`.
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
    // A gate left over from a prior turn still blocks the operator from
    // doing anything else, so the new turn inherits the exemption too.
    status: state.blockedGateCount > 0 ? "blocked" : "running",
    isProcessing: true,
    awaitingResponse: true,
    streamingType: null,
    currentToolName: null,
    streamTokenCount: 0,
    lastActivityAt: nowMs,
    activeToolCalls: [],
    callIdByName: {},
    streamText: "",
    repeating: false,
    repeatingSinceTokenCount: null,
    cycleFingerprint: null,
    consecutiveMatchingCycles: 0,
  };
}

/** Ctrl+C / watchdog abort: nothing is in flight and no prompt may be replayed. */
export function turnStateOnInterrupt(state: TurnState, nowMs: number): TurnState {
  return carryBlockedGateCount(state, {
    ...initialTurnState(nowMs),
    status: "stopped",
  });
}

/**
 * A gate was raised — queued or opened, the turn does not distinguish.
 * The first outstanding gate blocks the turn without ending it; further
 * gates just add to the count so the turn stays blocked until all clear.
 */
export function turnStateGateOpened(state: TurnState): TurnState {
  const blockedGateCount = state.blockedGateCount + 1;
  return {
    ...state,
    status: "blocked",
    isProcessing: true,
    blockedGateCount,
  };
}

/**
 * A gate resolved. Only the last outstanding gate clearing returns the turn
 * to "running" — earlier ones just decrement the count. `lastActivityAt`
 * moves to `nowMs` so the stall clock restarts from the moment the operator
 * actually answered, rather than crediting silence spent reading the prompt.
 */
export function turnStateGateClosed(state: TurnState, nowMs: number): TurnState {
  const blockedGateCount = Math.max(0, state.blockedGateCount - 1);
  if (blockedGateCount > 0) return { ...state, blockedGateCount };
  return {
    ...state,
    status: state.status === "blocked" ? "running" : state.status,
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
 * Text carried by a delta event. Reactor-shaped deltas carry it as
 * `data.token`; canonical bridge deltas carry it as a top-level `text`.
 */
function deltaText(event: { readonly data?: unknown; readonly text?: string }): string {
  const parsed = tokenData(event.data);
  if (!(parsed instanceof type.errors) && parsed.token !== undefined) {
    return parsed.token;
  }
  return event.text ?? "";
}

function quotaFromInferenceError(data: unknown, nowMs: number): QuotaWait | null {
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

// Both flat streamed shapes (`{ callId?, name? }`) and the nested tool.start
// shape (`{ call: { id?, callId?, name? } }`) are parsed here so every call
// site — the tool name shown in the UI and the activeToolCalls bookkeeping —
// reads one identity off one parse, instead of two schemas that could drift.
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

function withActiveCall(active: readonly string[], id: string): readonly string[] {
  return active.includes(id) ? active : [...active, id];
}

/**
 * Drop one outstanding call. An unmatched id still consumes an entry: a
 * mismatched pair would otherwise leave the turn permanently "working".
 */
function withoutActiveCall(active: readonly string[], id: string): readonly string[] {
  const index = active.indexOf(id);
  if (index !== -1) return active.filter((_, i) => i !== index);
  return active.slice(1);
}

interface CallTracking {
  readonly activeToolCalls: readonly string[];
  /**
   * Real id for a tool name once one has been seen. A name-only announcement
   * (start/end with no callId) and the id-bearing tool.start for the same
   * call share this mapping so the second collapses onto the first entry
   * instead of adding a duplicate. Two concurrent calls to the same tool
   * still collide here — the event stream carries no signal to tell them
   * apart until both have real ids — but that ambiguity predates this fix:
   * the original name-keyed tracking collapsed them identically.
   */
  readonly callIdByName: Readonly<Record<string, string>>;
}

/**
 * Canonicalize one logical call's identity at the event boundary: a
 * name-only announcement (no callId yet) and a later id-bearing one for the
 * same call must collapse onto a single activeToolCalls entry, not two.
 */
function registerActiveCall(tracking: CallTracking, identity: CallIdentity): CallTracking {
  const { activeToolCalls, callIdByName } = tracking;

  if (identity.id !== undefined) {
    const nextCallIdByName =
      identity.name !== undefined
        ? { ...callIdByName, [identity.name]: identity.id }
        : callIdByName;
    // A provisional entry may already be tracking this call under its name —
    // promote it onto the real id in place instead of adding a duplicate.
    const withoutPlaceholder =
      identity.name !== undefined && activeToolCalls.includes(identity.name)
        ? activeToolCalls.filter((c) => c !== identity.name)
        : activeToolCalls;
    return {
      activeToolCalls: withActiveCall(withoutPlaceholder, identity.id),
      callIdByName: nextCallIdByName,
    };
  }

  if (identity.name !== undefined) {
    const id = callIdByName[identity.name] ?? identity.name;
    return { activeToolCalls: withActiveCall(activeToolCalls, id), callIdByName };
  }

  return { activeToolCalls: withActiveCall(activeToolCalls, "tool"), callIdByName };
}

function withoutCallIdByName(
  callIdByName: Readonly<Record<string, string>>,
  name: string,
): Readonly<Record<string, string>> {
  if (!(name in callIdByName)) return callIdByName;
  return Object.fromEntries(Object.entries(callIdByName).filter(([n]) => n !== name));
}

/**
 * Which tool name (if any) maps to this id — tool.done rarely carries the
 * name itself, so resolving the id back to its name is the only way to clear
 * a finished call's entry without depending on the result payload's shape.
 */
function nameForCallId(
  callIdByName: Readonly<Record<string, string>>,
  id: string,
): string | undefined {
  return Object.entries(callIdByName).find(([, v]) => v === id)?.[0];
}

function unregisterActiveCall(tracking: CallTracking, identity: CallIdentity): CallTracking {
  const { activeToolCalls, callIdByName } = tracking;

  if (identity.id !== undefined) {
    // Clear the mapping once its call resolves, or a later call reusing the
    // same tool name would resolve straight to this now-finished id instead
    // of tracking its own — reproducing the leak this function exists to fix.
    const resolvedName = identity.name ?? nameForCallId(callIdByName, identity.id);
    const nextCallIdByName =
      resolvedName !== undefined ? withoutCallIdByName(callIdByName, resolvedName) : callIdByName;
    return {
      activeToolCalls: withoutActiveCall(activeToolCalls, identity.id),
      callIdByName: nextCallIdByName,
    };
  }

  if (identity.name !== undefined) {
    const id = callIdByName[identity.name] ?? identity.name;
    return {
      activeToolCalls: withoutActiveCall(activeToolCalls, id),
      callIdByName: withoutCallIdByName(callIdByName, identity.name),
    };
  }

  return { activeToolCalls: withoutActiveCall(activeToolCalls, "tool"), callIdByName };
}

const streaming = (
  state: TurnState,
  kind: "text" | "thinking",
  nowMs: number,
  text: string,
): TurnState => {
  const streamTokenCount = kind === "text" ? state.streamTokenCount + 1 : state.streamTokenCount;
  const streamText = `${state.streamText}${text}`.slice(-STREAM_TEXT_BUFFER_CHARS);
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

// A tool call ends the current streaming cycle. The raw text buffer is
// discarded here, rather than only on a fresh turn, so repeats never
// accumulate across `connector.reply` boundaries — the mechanism that turned
// nine separate narration lines ("Let me check the next file now.") into one
// apparent loop and killed an ordinary turn mid-flight. But discarding the
// buffer outright would also erase a genuine loop that interleaves a tool
// call between every repeat of the same block, so a fingerprint of the
// completed cycle is kept and compared against the next one: several
// consecutive cycles fingerprinting alike is what that shape of loop looks
// like, and nine different narration lines never do.
const runningTool = (state: TurnState, name: string | null, nowMs: number): TurnState => {
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
    state.repeating || consecutiveMatchingCycles >= CYCLE_REPETITION_MIN_CONSECUTIVE;

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
    cycleFingerprint: longEnoughToCompare ? fingerprint : state.cycleFingerprint,
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
        activeToolCalls: withActiveCall(state.activeToolCalls, event.name ?? "tool"),
      };
    }

    // Tool finished: the model is being called again, so the awaiting-response
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
      const activeToolCalls = withoutActiveCall(state.activeToolCalls, event.name ?? "tool");
      return {
        ...state,
        awaitingResponse: activeToolCalls.length === 0,
        streamingType: null,
        currentToolName: null,
        lastActivityAt: nowMs,
        activeToolCalls,
      };
    }

    /**
     * A cycle with no active tool calls left is also a turn's real
     * terminator: `connector.reply` (below) is the usual signal, but a
     * self-continuing workflow cycle may never emit one, and `reactor.done`
     * fires once at shutdown, never between
     * turns. Without settling here, the phase line stays hot ("working")
     * forever once nothing more arrives. A cycle that just requested tools
     * only ends here, not the turn — those calls are already reflected in
     * `activeToolCalls` (streamed before `inference.done`).
     */
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

    /**
     * The other turn terminator: `agent.send()` resolves on connector.reply,
     * and for the ordinary case above `inference.done` already settled the
     * turn a beat earlier, so this is a harmless idempotent re-settle. A
     * reply with tools still outstanding only ends the cycle, not the turn.
     */
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
