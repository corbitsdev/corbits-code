/**
 * Pure production stream/reactor → BridgeInboundEvent mapping.
 *
 * Mirrors the event types Ink's use-stream applyEvent paints for a normal turn
 * (user, assistant deltas, tools). No renderer / OpenTUI deps — unit-testable.
 */

import type { RunState } from "./session-queue.js"

/** Canonical inbound events the bridge understands (fixtures + mapped reactor). */
export type BridgeInboundEvent =
  | { readonly type: "user"; readonly text: string }
  | { readonly type: "assistant"; readonly text: string }
  | { readonly type: "assistant.delta"; readonly text: string }
  | { readonly type: "thinking.delta"; readonly text: string }
  | {
      readonly type: "tool_call"
      readonly name: string
      readonly detail?: string
    }
  | {
      readonly type: "tool_result"
      readonly name: string
      readonly detail?: string
      readonly isError?: boolean
    }
  | { readonly type: "system"; readonly text: string }
  | { readonly type: "run"; readonly state: RunState }
  | { readonly type: "tool.boundary" }
  | { readonly type: "error"; readonly message: string }

/** Loose reactor-shaped event (no hard dep on @intx/inference). */
export type ReactorLikeEvent = {
  readonly type: string
  readonly data?: unknown
  readonly seq?: number
}

/**
 * Reactor / stream types that are not bridge-native and must go through the
 * production mapper (avoids collisions like tool.done vs bridge tool_result).
 */
export const PRODUCTION_REACTOR_TYPES: ReadonlySet<string> = new Set([
  "message.received",
  "inference.start",
  "inference.done",
  "inference.text.delta",
  "inference.thinking.delta",
  "inference.tool_call.start",
  "inference.tool_call.delta",
  "inference.tool_call.end",
  "tool.start",
  "tool.done",
  "connector.reply",
  "reactor.done",
  "reactor.error",
  "inference.error",
])

/** Optional session bookkeeping so tool.done resolves names like use-stream. */
export type StreamMapContext = {
  readonly callIdToName: Map<string, string>
  readonly callIdToArgs: Map<string, string>
  /** callIds that already painted a tool_call row (avoid start/end doubles). */
  readonly emittedToolCalls: Set<string>
  /** True after text deltas in the current assistant burst (skip connector.reply paint). */
  hadTextDelta: boolean
}

export function createStreamMapContext(): StreamMapContext {
  return {
    callIdToName: new Map(),
    callIdToArgs: new Map(),
    emittedToolCalls: new Set(),
    hadTextDelta: false,
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

function dataOf(event: ReactorLikeEvent): Record<string, unknown> {
  return asRecord(event.data) ?? {}
}

function stringifyDetail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value.length > 0 ? value : undefined
  try {
    const s = JSON.stringify(value)
    return s.length > 0 ? s : undefined
  } catch {
    return String(value)
  }
}

function trackCall(
  ctx: StreamMapContext | undefined,
  callId: string | undefined,
  name: string | undefined,
  args?: unknown,
): void {
  if (!ctx || !callId) return
  if (name && name.length > 0) ctx.callIdToName.set(callId, name)
  if (args !== undefined) {
    const detail = stringifyDetail(args)
    if (detail !== undefined) ctx.callIdToArgs.set(callId, detail)
  }
}

function resolveToolName(
  ctx: StreamMapContext | undefined,
  callId: string | undefined,
  explicit: string | undefined,
): string {
  if (explicit && explicit.length > 0) return explicit
  if (ctx && callId) {
    const tracked = ctx.callIdToName.get(callId)
    if (tracked) return tracked
  }
  if (callId && callId.length > 0) return callId
  return "tool"
}

function toolCallEvent(
  name: string,
  detail: string | undefined,
): BridgeInboundEvent {
  return detail !== undefined
    ? { type: "tool_call", name, detail }
    : { type: "tool_call", name }
}

/**
 * Map one production-shaped reactor/stream event into zero or more bridge events.
 *
 * When `ctx` is provided, callId→name tracking matches use-stream fidelity
 * (tool.done without result.name, connector.reply after deltas, no double tool_call).
 * Stateless calls remain safe for fixtures and simple unit tests.
 */
export function mapProductionEvent(
  event: ReactorLikeEvent,
  ctx?: StreamMapContext,
): readonly BridgeInboundEvent[] {
  const { type } = event
  const data = dataOf(event)

  switch (type) {
    case "message.received": {
      const message = asRecord(data.message)
      const content =
        typeof message?.content === "string" ? message.content : ""
      const attachments = Array.isArray(message?.attachments)
        ? (message.attachments as Array<{ name?: string }>)
        : []
      const attachmentText =
        attachments.length > 0
          ? `\n[Attached ${attachments.length} image${attachments.length === 1 ? "" : "s"}: ${attachments.map((a) => a.name ?? "image").join(", ")}]`
          : ""
      const full = `${content}${attachmentText}`
      if (full.trim().length === 0) return []
      return [{ type: "user", text: full }]
    }

    case "inference.start":
      if (ctx) ctx.hadTextDelta = false
      return [{ type: "run", state: "busy" }]

    case "inference.done":
      // Cycle settled; no transcript row (use-stream only disarms rollback).
      return []

    case "inference.text.delta": {
      const token = typeof data.token === "string" ? data.token : ""
      if (token.length === 0) return []
      if (ctx) ctx.hadTextDelta = true
      return [{ type: "assistant.delta", text: token }]
    }

    case "inference.thinking.delta": {
      // Chain-of-thought is not transcript content: it coalesces into its own
      // dim "thinking" row rather than interleaving with system chrome.
      const token = typeof data.token === "string" ? data.token : ""
      if (token.length === 0) return []
      return [{ type: "thinking.delta", text: token }]
    }

    case "inference.tool_call.start": {
      const name = typeof data.name === "string" ? data.name : "tool"
      const callId = typeof data.callId === "string" ? data.callId : undefined
      trackCall(ctx, callId, name)
      // Prefer painting at end with final arguments; early start is tracking only
      // when we have a callId. Without callId, emit immediately.
      if (ctx && callId) return []
      return [toolCallEvent(name, undefined)]
    }

    case "inference.tool_call.delta": {
      const fragment =
        typeof data.argumentFragment === "string" ? data.argumentFragment : ""
      const callId = typeof data.callId === "string" ? data.callId : undefined
      if (ctx && callId && fragment.length > 0) {
        const prev = ctx.callIdToArgs.get(callId) ?? ""
        ctx.callIdToArgs.set(callId, prev + fragment)
      }
      // Deltas coalesce into the final tool_call at end — no intermediate rows.
      return []
    }

    case "inference.tool_call.end": {
      const name = typeof data.name === "string" ? data.name : "tool"
      const callId = typeof data.callId === "string" ? data.callId : undefined
      const streamed =
        ctx && callId ? ctx.callIdToArgs.get(callId) : undefined
      const detail =
        data.arguments !== undefined
          ? stringifyDetail(data.arguments)
          : streamed
      trackCall(ctx, callId, name, data.arguments !== undefined ? data.arguments : streamed)
      if (ctx && callId) ctx.emittedToolCalls.add(callId)
      return [toolCallEvent(name, detail)]
    }

    case "tool.start": {
      const call = asRecord(data.call)
      const name =
        typeof call?.name === "string" ? call.name : "tool"
      const callId =
        typeof call?.id === "string"
          ? call.id
          : typeof call?.callId === "string"
            ? call.callId
            : undefined
      trackCall(ctx, callId, name)
      // use-stream does not paint on tool.start; skip if tool_call already painted.
      if (ctx && callId && ctx.emittedToolCalls.has(callId)) return []
      if (ctx && callId) ctx.emittedToolCalls.add(callId)
      return [toolCallEvent(name, undefined)]
    }

    case "tool.done": {
      const result = asRecord(data.result)
      const callId =
        typeof result?.callId === "string" ? result.callId : undefined
      const explicitName =
        typeof result?.name === "string" ? result.name : undefined
      const name = resolveToolName(ctx, callId, explicitName)
      const detail = stringifyDetail(result?.content)
      const isError = result?.isError === true
      if (ctx && callId) {
        ctx.callIdToName.delete(callId)
        ctx.callIdToArgs.delete(callId)
        ctx.emittedToolCalls.delete(callId)
      }
      const out: BridgeInboundEvent = {
        type: "tool_result",
        name,
        ...(detail !== undefined ? { detail } : {}),
        ...(isError ? { isError: true } : {}),
      }
      return [out, { type: "tool.boundary" }]
    }

    case "connector.reply": {
      const content = typeof data.content === "string" ? data.content : ""
      if (ctx?.hadTextDelta) {
        ctx.hadTextDelta = false
        // Text already painted via assistant.delta — match use-stream skip.
        return []
      }
      if (content.trim().length === 0) return []
      return [{ type: "assistant", text: content }]
    }

    case "reactor.done":
      if (ctx) ctx.hadTextDelta = false
      return [{ type: "run", state: "idle" }, { type: "tool.boundary" }]

    case "reactor.error": {
      const error =
        typeof data.error === "string" ? data.error : "reactor error"
      if (ctx) ctx.hadTextDelta = false
      return [
        { type: "error", message: error },
        { type: "run", state: "idle" },
      ]
    }

    case "inference.error": {
      const err = asRecord(data.error)
      const message =
        typeof err?.message === "string"
          ? err.message
          : typeof data.error === "string"
            ? data.error
            : "inference error"
      return [{ type: "error", message }]
    }

    default:
      return []
  }
}

/**
 * Stateless reactor → bridge map (fixture-friendly). Prefer
 * `mapProductionEvent(event, ctx)` for live sessions.
 */
export function mapReactorLike(
  event: ReactorLikeEvent,
): readonly BridgeInboundEvent[] {
  return mapProductionEvent(event)
}

/** Fold a sequence of production events through a shared map context. */
export function mapProductionSequence(
  events: readonly ReactorLikeEvent[],
  ctx: StreamMapContext = createStreamMapContext(),
): BridgeInboundEvent[] {
  const out: BridgeInboundEvent[] = []
  for (const event of events) {
    out.push(...mapProductionEvent(event, ctx))
  }
  return out
}
