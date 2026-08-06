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
  readonly lastActivityAt: number
  /** Set while a provider rate limit is cooling down. */
  readonly quota: QuotaWait | null
}

export function initialTurnState(nowMs: number): TurnState {
  return {
    status: "idle",
    isProcessing: false,
    awaitingResponse: false,
    streamingType: null,
    currentToolName: null,
    lastActivityAt: nowMs,
    quota: null,
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
    lastActivityAt: nowMs,
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

    case "inference.tool_call.start":
    case "inference.tool_call.delta":
    case "inference.tool_call.end":
      return runningTool(state, toolName(event.data), nowMs)

    case "tool.start":
      return runningTool(state, toolName(event.data), nowMs)

    case "tool_call":
      return runningTool(state, event.name ?? null, nowMs)

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
      }

    case "inference.done":
      return {
        ...state,
        awaitingResponse: false,
        streamingType: null,
        lastActivityAt: nowMs,
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
