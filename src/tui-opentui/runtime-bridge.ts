/**
 * Wave 4 runtime bridge — thin port between OpenTUI shell and session events.
 *
 * Inbound: fixture or reactor-like events → stream rows + run state + queue drain.
 * Outbound: queue / steer / interrupt / immediate send hit SessionPort (tests record;
 * later waves can bind real agent APIs). Not the production CLI entry.
 */

import {
  badgeCount,
  drainOne,
  enqueue,
  enqueueSteer,
  setRunState,
  type QueueItem,
  type QueueKind,
  type RunState,
} from "./session-queue.js"
import {
  appendStreamRow,
  applyShellInterrupt,
  clearShellBridgeHooks,
  paintStatus,
  setShellBridgeHooks,
  type AppShell,
} from "./shell.js"
import type { StreamRow } from "./stream.js"

/** Outbound actions the UI asks the session runtime to perform. */
export type SessionPort = {
  /** Idle prompt submit — deliver now. */
  sendImmediate: (text: string) => void
  /** Mid-run queue or steer accepted by the shell. */
  enqueue: (text: string, kind: QueueKind) => void
  /** Hard interrupt current run. */
  interrupt: () => void
  /** Queue item drained at a tool boundary (or idle). */
  deliver: (item: QueueItem) => void
}

export type SessionPortHandlers = Partial<SessionPort>

/** Canonical inbound events the bridge understands (fixtures + mapped reactor). */
export type BridgeInboundEvent =
  | { readonly type: "user"; readonly text: string }
  | { readonly type: "assistant"; readonly text: string }
  | { readonly type: "assistant.delta"; readonly text: string }
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

/** Loose reactor-shaped event (no hard dep on @intx/inference in this module). */
export type ReactorLikeEvent = {
  readonly type: string
  readonly data?: unknown
  readonly seq?: number
}

export type SessionBridge = {
  /** Apply a canonical or reactor-like event to the shell. */
  handle: (event: BridgeInboundEvent | ReactorLikeEvent) => void
  /** Replay a fixture sequence. */
  play: (events: readonly (BridgeInboundEvent | ReactorLikeEvent)[]) => void
  /** Operator paths — shell keys go through the same logic via exclusive hooks. */
  submit: (text: string, kind: "queue" | "steer" | "immediate") => void
  interrupt: () => void
  dispose: () => void
  readonly shell: AppShell
}

const NOOP_PORT: SessionPort = {
  sendImmediate: () => {},
  enqueue: () => {},
  interrupt: () => {},
  deliver: () => {},
}

export type PortCall =
  | { readonly op: "sendImmediate"; readonly text: string }
  | { readonly op: "enqueue"; readonly text: string; readonly kind: QueueKind }
  | { readonly op: "interrupt" }
  | { readonly op: "deliver"; readonly item: QueueItem }

export function createRecordingPort(): SessionPort & {
  readonly calls: readonly PortCall[]
  clear: () => void
} {
  const calls: PortCall[] = []
  return {
    get calls() {
      return calls
    },
    clear: () => {
      calls.length = 0
    },
    sendImmediate: (text) => {
      calls.push({ op: "sendImmediate", text })
    },
    enqueue: (text, kind) => {
      calls.push({ op: "enqueue", text, kind })
    },
    interrupt: () => {
      calls.push({ op: "interrupt" })
    },
    deliver: (item) => {
      calls.push({ op: "deliver", item })
    },
  }
}

function isBridgeInbound(event: {
  type: string
}): event is BridgeInboundEvent {
  switch (event.type) {
    case "user":
    case "assistant":
    case "assistant.delta":
    case "tool_call":
    case "tool_result":
    case "system":
    case "run":
    case "tool.boundary":
    case "error":
      return true
    default:
      return false
  }
}

/** Reactor event types that must go through mapReactorLike (not bridge-native). */
const REACTOR_TYPES = new Set([
  "message.received",
  "inference.start",
  "inference.text.delta",
  "inference.tool_call.end",
  "tool.start",
  "tool.done",
  "connector.reply",
  "reactor.done",
  "reactor.error",
  "inference.error",
])

/**
 * Map a reactor-like event into zero or more canonical bridge events.
 * Covers the subset needed for fixture sessions and later real wiring.
 */
export function mapReactorLike(
  event: ReactorLikeEvent,
): readonly BridgeInboundEvent[] {
  const { type, data } = event
  switch (type) {
    case "message.received": {
      const msg = (data as { message?: { content?: string } } | undefined)
        ?.message
      const text = msg?.content ?? ""
      if (text.trim().length === 0) return []
      return [{ type: "user", text }]
    }
    case "inference.start":
      return [{ type: "run", state: "busy" }]
    case "inference.text.delta": {
      const token = (data as { token?: string } | undefined)?.token ?? ""
      if (token.length === 0) return []
      return [{ type: "assistant.delta", text: token }]
    }
    case "inference.tool_call.end": {
      const d = data as { name?: string; arguments?: unknown } | undefined
      const name = d?.name ?? "tool"
      const detail =
        typeof d?.arguments === "string"
          ? d.arguments
          : d?.arguments !== undefined
            ? JSON.stringify(d.arguments)
            : undefined
      return [{ type: "tool_call", name, ...(detail ? { detail } : {}) }]
    }
    case "tool.start": {
      const call = (data as { call?: { name?: string } } | undefined)?.call
      const name = call?.name ?? "tool"
      return [{ type: "tool_call", name }]
    }
    case "tool.done": {
      const result = (
        data as
          | {
              result?: {
                callId?: string
                content?: unknown
                isError?: boolean
                name?: string
              }
            }
          | undefined
      )?.result
      const name = result?.name ?? "tool"
      const detail =
        typeof result?.content === "string"
          ? result.content
          : result?.content !== undefined
            ? JSON.stringify(result.content)
            : undefined
      const out: BridgeInboundEvent = {
        type: "tool_result",
        name,
        ...(detail ? { detail } : {}),
        ...(result?.isError ? { isError: true } : {}),
      }
      // Tool boundary: ASAP injection point after tool result.
      return [out, { type: "tool.boundary" }]
    }
    case "connector.reply": {
      const content =
        (data as { content?: string } | undefined)?.content ?? ""
      if (content.trim().length === 0) return []
      return [{ type: "assistant", text: content }]
    }
    case "reactor.done":
      return [{ type: "run", state: "idle" }, { type: "tool.boundary" }]
    case "reactor.error": {
      const error =
        (data as { error?: string } | undefined)?.error ?? "reactor error"
      return [
        { type: "error", message: error },
        { type: "run", state: "idle" },
      ]
    }
    case "inference.error": {
      const message =
        (data as { error?: { message?: string } } | undefined)?.error
          ?.message ?? "inference error"
      return [{ type: "error", message }]
    }
    default:
      return []
  }
}

function rowFromInbound(event: BridgeInboundEvent): StreamRow | null {
  switch (event.type) {
    case "user":
      return { role: "user", text: event.text }
    case "assistant":
      return { role: "assistant", text: event.text }
    case "tool_call":
      return {
        role: "tool",
        text: event.detail ?? "…",
        meta: event.name,
      }
    case "tool_result": {
      const body = event.detail ?? (event.isError ? "error" : "ok")
      return {
        role: "tool",
        text: body,
        meta: event.isError ? `${event.name}!` : event.name,
      }
    }
    case "system":
      return { role: "system", text: event.text }
    case "error":
      return { role: "system", text: event.message, meta: "error" }
    default:
      return null
  }
}

type BridgeBag = {
  port: SessionPort
  /** Accumulator for assistant.delta coalescing. */
  deltaBuf: string
  disposed: boolean
}

const bridges = new WeakMap<AppShell, BridgeBag>()

function resolvePort(handlers?: SessionPortHandlers): SessionPort {
  return {
    sendImmediate: handlers?.sendImmediate ?? NOOP_PORT.sendImmediate,
    enqueue: handlers?.enqueue ?? NOOP_PORT.enqueue,
    interrupt: handlers?.interrupt ?? NOOP_PORT.interrupt,
    deliver: handlers?.deliver ?? NOOP_PORT.deliver,
  }
}

function flushDelta(shell: AppShell, bag: BridgeBag): void {
  if (bag.deltaBuf.length === 0) return
  appendStreamRow(shell, { role: "assistant", text: bag.deltaBuf })
  bag.deltaBuf = ""
}

function drainAtBoundary(shell: AppShell, bag: BridgeBag): void {
  for (;;) {
    const { state, item } = drainOne(shell.session)
    if (!item) break
    shell.session = state
    appendStreamRow(shell, {
      role: "user",
      text: item.text,
      meta: item.kind === "steer" ? "steer" : "queued",
    })
    bag.port.deliver(item)
  }
  paintStatus(shell)
}

function applyInbound(
  shell: AppShell,
  bag: BridgeBag,
  event: BridgeInboundEvent,
): void {
  if (bag.disposed) return

  if (event.type === "assistant.delta") {
    bag.deltaBuf += event.text
    return
  }

  flushDelta(shell, bag)

  if (event.type === "run") {
    shell.session = setRunState(shell.session, event.state)
    paintStatus(shell)
    if (event.state === "idle") {
      drainAtBoundary(shell, bag)
    }
    return
  }

  if (event.type === "tool.boundary") {
    drainAtBoundary(shell, bag)
    return
  }

  const row = rowFromInbound(event)
  if (row) appendStreamRow(shell, row)
  paintStatus(shell)
}

/**
 * Attach a session bridge to a shell. Operator submit/interrupt go through
 * the port; inbound events paint the transcript and drain at tool boundaries.
 */
export function attachSessionBridge(
  shell: AppShell,
  handlers?: SessionPortHandlers,
): SessionBridge {
  const existing = bridges.get(shell)
  if (existing) {
    existing.disposed = true
  }

  const bag: BridgeBag = {
    port: resolvePort(handlers),
    deltaBuf: "",
    disposed: false,
  }
  bridges.set(shell, bag)

  const handle = (event: BridgeInboundEvent | ReactorLikeEvent): void => {
    if (bag.disposed) return
    // Reactor-shaped types always map first (avoids tool.done name collision).
    if (REACTOR_TYPES.has(event.type)) {
      for (const mapped of mapReactorLike(event as ReactorLikeEvent)) {
        applyInbound(shell, bag, mapped)
      }
      return
    }
    if (isBridgeInbound(event)) {
      applyInbound(shell, bag, event)
    }
  }

  const submit = (
    text: string,
    kind: "queue" | "steer" | "immediate",
  ): void => {
    if (bag.disposed) return
    const t = text.trim()
    if (t.length === 0) return

    if (kind === "immediate" || shell.session.run === "idle") {
      appendStreamRow(shell, { role: "user", text: t })
      bag.port.sendImmediate(t)
      shell.session = setRunState(shell.session, "busy")
      paintStatus(shell)
      return
    }

    shell.session =
      kind === "steer"
        ? enqueueSteer(shell.session, t)
        : enqueue(shell.session, t)
    bag.port.enqueue(t, kind)
    appendStreamRow(shell, {
      role: "system",
      text: `${kind} +1 → pending ${badgeCount(shell.session)}`,
      meta: "queue",
    })
    paintStatus(shell)
  }

  const doInterrupt = (): void => {
    if (bag.disposed) return
    applyShellInterrupt(shell)
    bag.port.interrupt()
  }

  setShellBridgeHooks(shell, {
    onSubmit: (text, kind) => {
      submit(text, kind)
    },
    onInterrupt: () => {
      doInterrupt()
    },
    exclusive: true,
  })

  return {
    shell,
    handle,
    play: (events) => {
      for (const e of events) handle(e)
    },
    submit,
    interrupt: doInterrupt,
    dispose: () => {
      bag.disposed = true
      clearShellBridgeHooks(shell)
      bridges.delete(shell)
    },
  }
}

/** Sample fixture: busy run with tools, queue drain at boundary. */
export const FIXTURE_BUSY_SESSION: readonly ReactorLikeEvent[] = [
  { type: "inference.start", data: {} },
  {
    type: "message.received",
    data: { message: { content: "list project root" } },
  },
  { type: "inference.text.delta", data: { token: "I'll " } },
  { type: "inference.text.delta", data: { token: "list the directory." } },
  {
    type: "inference.tool_call.end",
    data: { name: "bash", callId: "c1", arguments: "ls -la" },
  },
  {
    type: "tool.done",
    data: {
      result: {
        callId: "c1",
        name: "bash",
        content: "AGENTS.md\nREADME.md",
        isError: false,
      },
    },
  },
  {
    type: "inference.text.delta",
    data: { token: "Done — two top-level docs." },
  },
  { type: "reactor.done", data: {} },
]
