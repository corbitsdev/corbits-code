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
import {
  PRODUCTION_REACTOR_TYPES,
  createStreamMapContext,
  mapProductionEvent,
  mapReactorLike as mapReactorLikeImpl,
  type BridgeInboundEvent,
  type ReactorLikeEvent,
  type StreamMapContext,
} from "./stream-event-map.js"

/** Re-export map types so existing `from "./runtime-bridge"` imports keep working. */
export type { BridgeInboundEvent, ReactorLikeEvent, StreamMapContext }

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

/**
 * Map a reactor-like event into zero or more canonical bridge events.
 * Stateless (fixture-friendly). Live sessions use a StreamMapContext via handle.
 */
export function mapReactorLike(
  event: ReactorLikeEvent,
): readonly BridgeInboundEvent[] {
  return mapReactorLikeImpl(event)
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
  /** callId→name / delta bookkeeping for production-shaped events. */
  mapCtx: StreamMapContext
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
    mapCtx: createStreamMapContext(),
    disposed: false,
  }
  bridges.set(shell, bag)

  const handle = (event: BridgeInboundEvent | ReactorLikeEvent): void => {
    if (bag.disposed) return
    // Reactor-shaped types always map first (avoids tool.done name collision).
    if (PRODUCTION_REACTOR_TYPES.has(event.type)) {
      for (const mapped of mapProductionEvent(
        event as ReactorLikeEvent,
        bag.mapCtx,
      )) {
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
