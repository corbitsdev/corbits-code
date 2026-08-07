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

import { type } from "arktype"

import type { TurnStatus } from "./session-chrome.js"

export type QuotaWait = {
  readonly retryAfterMs: number
  readonly retryAt: number
}

export type TurnState = {
  readonly status: TurnStatus
  readonly isProcessing: boolean
  /** Between a request and its first streamed token. */
  readonly awaitingResponse: boolean
  readonly streamingType: "text" | "thinking" | "tool" | null
  readonly currentToolName: string | null
  /**
   * Text deltas seen so far this turn — the only live count available: usage
   * totals only land on `inference.done`, well after the turn has finished
   * streaming. Counts delta events, not a real tokenizer, so it is a proxy
   * for "how much has arrived" rather than an exact token count.
   */
  readonly streamTokenCount: number
  readonly lastActivityAt: number
  /** Set while a provider rate limit is cooling down. */
  readonly quota: QuotaWait | null
  /**
   * Tool calls streamed by the current cycle that have not reported a result.
   * `connector.reply` closes a cycle but not the turn when tools are still out,
   * so the settle decision needs the outstanding ids, not just the last name.
   */
  readonly activeToolCalls: readonly string[]
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
  }
}

/** Operator submitted a prompt: the run is live and awaiting first tokens. */
export function turnStateOnSubmit(state: TurnState, nowMs: number): TurnState {
  return {
    ...state,
    status: "running",
    isProcessing: true,
    awaitingResponse: true,
    streamingType: null,
    currentToolName: null,
    streamTokenCount: 0,
    lastActivityAt: nowMs,
    activeToolCalls: [],
  }
}

/** Ctrl+C / watchdog abort: nothing is in flight and no prompt may be replayed. */
export function turnStateOnInterrupt(_state: TurnState, nowMs: number): TurnState {
  return { ...initialTurnState(nowMs), status: "stopped" }
}

/** A pending approval gate blocks the turn without ending it. */
export function turnStateBlocked(state: TurnState): TurnState {
  return { ...state, status: "blocked", isProcessing: true }
}

export function clearQuotaWait(state: TurnState): TurnState {
  return state.quota === null ? state : { ...state, quota: null }
}

const inferenceErrorData = type({
  error: {
    category: "string",
    "retryAfterMs?": "number",
  },
})

const namedCallData = type({ "name?": "string" })
const toolStartData = type({
  call: { "name?": "string" },
})

function quotaFromInferenceError(
  data: unknown,
  nowMs: number,
): QuotaWait | null {
  const parsed = inferenceErrorData(data)
  if (parsed instanceof type.errors) return null
  const { category, retryAfterMs } = parsed.error
  if (category !== "quota_exhausted" || retryAfterMs === undefined) return null
  return { retryAfterMs, retryAt: nowMs + retryAfterMs }
}

function toolName(data: unknown): string | null {
  const named = namedCallData(data)
  if (!(named instanceof type.errors) && named.name !== undefined) {
    return named.name
  }
  const started = toolStartData(data)
  if (!(started instanceof type.errors) && started.call.name !== undefined) {
    return started.call.name
  }
  return null
}

const callIdData = type({ "callId?": "string", "name?": "string" })
const toolStartCallData = type({
  call: { "id?": "string", "callId?": "string", "name?": "string" },
})
const toolDoneData = type({
  result: { "callId?": "string", "name?": "string" },
})

/**
 * Stable handle for one outstanding tool call. Providers that stream a callId
 * give a real one; the rest fall back to the name so at least the count is
 * right, which is all the settle decision reads.
 */
function streamedCallId(data: unknown): string {
  const parsed = callIdData(data)
  if (!(parsed instanceof type.errors)) {
    if (parsed.callId !== undefined) return parsed.callId
    if (parsed.name !== undefined) return parsed.name
  }
  const started = toolStartCallData(data)
  if (!(started instanceof type.errors)) {
    const { id, callId, name } = started.call
    return id ?? callId ?? name ?? "tool"
  }
  return "tool"
}

function resultCallId(data: unknown): string {
  const parsed = toolDoneData(data)
  if (parsed instanceof type.errors) return "tool"
  return parsed.result.callId ?? parsed.result.name ?? "tool"
}

function withActiveCall(
  active: readonly string[],
  id: string,
): readonly string[] {
  return active.includes(id) ? active : [...active, id]
}

/**
 * Drop one outstanding call. An unmatched id still consumes an entry: a
 * mismatched pair would otherwise leave the turn permanently "working".
 */
function withoutActiveCall(
  active: readonly string[],
  id: string,
): readonly string[] {
  const index = active.indexOf(id)
  if (index !== -1) return active.filter((_, i) => i !== index)
  return active.slice(1)
}

const streaming = (
  state: TurnState,
  kind: "text" | "thinking",
  nowMs: number,
): TurnState => ({
  ...state,
  status: state.status === "blocked" ? "blocked" : "running",
  isProcessing: true,
  awaitingResponse: false,
  streamingType: kind,
  streamTokenCount:
    kind === "text" ? state.streamTokenCount + 1 : state.streamTokenCount,
  lastActivityAt: nowMs,
})

const runningTool = (
  state: TurnState,
  name: string | null,
  nowMs: number,
): TurnState => ({
  ...state,
  status: state.status === "blocked" ? "blocked" : "running",
  isProcessing: true,
  awaitingResponse: false,
  streamingType: "tool",
  currentToolName: name ?? state.currentToolName,
  lastActivityAt: nowMs,
})

/**
 * Fold one inbound event (reactor-shaped or canonical bridge-shaped) into the
 * turn state. Unknown types leave the state untouched.
 */
export function turnStateFromEvent(
  state: TurnState,
  event: {
    readonly type: string
    readonly data?: unknown
    /** Canonical bridge shapes carry these instead of `data`. */
    readonly state?: string
    readonly name?: string
  },
  nowMs: number,
): TurnState {
  switch (event.type) {
    case "message.received":
      return turnStateOnSubmit(state, nowMs)

    case "inference.start":
      return {
        ...state,
        status: state.status === "blocked" ? "blocked" : "running",
        isProcessing: true,
        awaitingResponse: true,
        streamingType: null,
        currentToolName: null,
        lastActivityAt: nowMs,
      }

    case "inference.text.delta":
    case "assistant.delta":
      return streaming(state, "text", nowMs)

    case "inference.thinking.delta":
      return streaming(state, "thinking", nowMs)

    case "inference.tool_call.delta":
      return runningTool(state, toolName(event.data), nowMs)

    case "inference.tool_call.start":
    case "inference.tool_call.end":
    case "tool.start": {
      const running = runningTool(state, toolName(event.data), nowMs)
      return {
        ...running,
        activeToolCalls: withActiveCall(
          state.activeToolCalls,
          streamedCallId(event.data),
        ),
      }
    }

    case "tool_call": {
      const running = runningTool(state, event.name ?? null, nowMs)
      return {
        ...running,
        activeToolCalls: withActiveCall(
          state.activeToolCalls,
          event.name ?? "tool",
        ),
      }
    }

    // Tool finished: the model is being called again, so the awaiting-response
    // clock restarts rather than the tool clock continuing.
    case "tool.done":
    case "tool_result":
      return {
        ...state,
        awaitingResponse: true,
        streamingType: null,
        currentToolName: null,
        lastActivityAt: nowMs,
        activeToolCalls: withoutActiveCall(
          state.activeToolCalls,
          event.type === "tool.done"
            ? resultCallId(event.data)
            : (event.name ?? "tool"),
        ),
      }

    /**
     * A cycle with no active tool calls left is also a turn's real
     * terminator: `connector.reply` (below) is the usual signal, but a
     * workflow/goal-governor cycle that keeps self-continuing may never
     * emit one, and `reactor.done` fires once at shutdown, never between
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
        }
      }
      return {
        ...initialTurnState(nowMs),
        status: "done",
        quota: state.quota,
      }

    /**
     * The other turn terminator: `agent.send()` resolves on connector.reply,
     * and for the ordinary case above `inference.done` already settled the
     * turn a beat earlier, so this is a harmless idempotent re-settle. A
     * reply with tools still outstanding only ends the cycle, not the turn.
     */
    case "connector.reply":
      if (state.activeToolCalls.length > 0) {
        return { ...state, awaitingResponse: false, lastActivityAt: nowMs }
      }
      return {
        ...initialTurnState(nowMs),
        status: "done",
        quota: state.quota,
      }

    case "inference.error": {
      const quota = quotaFromInferenceError(event.data, nowMs)
      return {
        ...state,
        lastActivityAt: nowMs,
        ...(quota !== null ? { quota } : {}),
      }
    }

    case "reactor.done":
      return { ...initialTurnState(nowMs), quota: state.quota }

    case "reactor.error":
      return { ...initialTurnState(nowMs), status: "failed" }

    case "run":
      return event.state === "busy"
        ? turnStateOnSubmit(state, nowMs)
        : { ...initialTurnState(nowMs), quota: state.quota }

    default:
      return state
  }
}
