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
  paintChrome,
  replaceStreamRowAt,
  setShellBridgeHooks,
  setStatusFlash,
  setTurnPhase,
  streamRowCount,
  type AppShell,
} from "./shell.js"
import { rampFor, rampLine } from "./ramp.js"
import { resolveRampPhase, resolveTurnLabel } from "./session-chrome.js"
import { quotaWaitSeconds, shouldAutoRetryQuota } from "./quota-retry.js"
import {
  applyStallRecovery,
  shouldAbortForStall,
  STALL_TIMEOUT_MS,
} from "./stall-watchdog.js"
import {
  clearQuotaWait,
  initialTurnState,
  turnStateFromEvent,
  turnStateBlocked,
  turnStateOnInterrupt,
  turnStateOnSubmit,
  type TurnState,
} from "./turn-state.js"
import {
  formatAttachmentSummary,
  type PendingImageAttachment,
} from "../tui/image-attachments.js"
import { toolCallRow } from "./diff.js"
import { toolResultRow } from "./mcp-view.js"
import type { StreamRow } from "./stream.js"

/** Transcript echo for a user message, annotated with its attachments. */
function userRowText(
  text: string,
  attachments: readonly PendingImageAttachment[],
): string {
  const summary = formatAttachmentSummary(attachments)
  if (summary.length === 0) return text
  return text.length === 0 ? `[${summary}]` : `${text}\n[${summary}]`
}
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
  sendImmediate: (
    text: string,
    attachments?: readonly PendingImageAttachment[],
  ) => void
  /** Mid-run queue or steer accepted by the shell. */
  enqueue: (text: string, kind: QueueKind) => void
  /** Hard interrupt current run. */
  interrupt: () => void
  /** Queue item drained at a tool boundary (or idle). */
  deliver: (item: QueueItem) => void
}

export type SessionPortHandlers = Partial<SessionPort>

/**
 * Timer wiring for the quota auto-retry and stall watchdog.
 *
 * Everything is injectable so tests drive the clock instead of waiting on it:
 * `schedule` returns its own cancel, and `now` is the only time source.
 */
export type TurnMonitorOptions = {
  readonly now?: () => number
  /** Poll period for the retry countdown and the stall check. Default 250 ms. */
  readonly tickMs?: number
  readonly stallTimeoutMs?: number
  /** Registers the periodic tick; returns an unsubscribe. */
  readonly schedule?: (tick: () => void, intervalMs: number) => () => void
}

const DEFAULT_TICK_MS = 250

function defaultSchedule(tick: () => void, intervalMs: number): () => void {
  const handle = setInterval(tick, intervalMs)
  // The monitor must never be the reason the process stays alive.
  handle.unref?.()
  return () => {
    clearInterval(handle)
  }
}

export type SessionBridge = {
  /** Apply a canonical or reactor-like event to the shell. */
  handle: (event: BridgeInboundEvent | ReactorLikeEvent) => void
  /** Replay a fixture sequence. */
  play: (events: readonly (BridgeInboundEvent | ReactorLikeEvent)[]) => void
  /** Operator paths — shell keys go through the same logic via exclusive hooks. */
  submit: (
    text: string,
    kind: "queue" | "steer" | "immediate",
    attachments?: readonly PendingImageAttachment[],
  ) => void
  interrupt: () => void
  dispose: () => void
  /** Current derived turn phase (progress label, stall clock, quota window). */
  readonly turn: TurnState
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
    case "thinking.delta":
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
      return toolCallRow({
        name: event.name,
        ...(event.detail !== undefined ? { arguments: event.detail } : {}),
      })
    case "tool_result":
      return toolResultRow({
        name: event.name,
        content: event.detail ?? (event.isError ? "error" : "ok"),
        isError: event.isError === true,
      })
    case "system":
      return { role: "system", text: event.text }
    case "error":
      return { role: "system", text: event.message, meta: "error" }
    default:
      return null
  }
}

/** Streaming row kinds the bridge grows in place, one row per message. */
type OpenRowKind = "assistant" | "thinking"

/** The transcript row deltas are currently appending to. */
type OpenStreamRow = {
  readonly kind: OpenRowKind
  readonly index: number
  text: string
}

type BridgeBag = {
  port: SessionPort
  openRow: OpenStreamRow | null
  /**
   * Prompts already echoed locally. The runtime replays each one as
   * `message.received`; without this the transcript shows the message twice.
   */
  pendingEchoes: string[]
  /** callId→name / delta bookkeeping for production-shaped events. */
  mapCtx: StreamMapContext
  disposed: boolean
  turn: TurnState
  /** Last prompt actually sent — replay source for the quota auto-retry. */
  lastSentMessage: string
  /** One auto-retry per rate-limit window. */
  quotaFired: boolean
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

/**
 * Prompt text without the attachment note. The local echo and the runtime's
 * `message.received` word that note differently, so echoes match on content.
 */
function promptContent(text: string): string {
  const note = text.indexOf("\n[")
  return (note === -1 ? text : text.slice(0, note)).trim()
}

/** True when this inbound user message is one the shell already painted. */
function consumeEcho(bag: BridgeBag, text: string): boolean {
  const index = bag.pendingEchoes.indexOf(promptContent(text))
  if (index === -1) return false
  bag.pendingEchoes.splice(index, 1)
  return true
}

function openRowContent(kind: OpenRowKind, text: string, streaming: boolean): StreamRow {
  return kind === "assistant"
    ? { role: "assistant", text, streaming }
    : { role: "system", text, meta: "thinking", streaming }
}

/** Finalize the open streaming row: it stops growing and stops being unstable. */
function closeOpenRow(shell: AppShell, bag: BridgeBag): void {
  const open = bag.openRow
  if (open === null) return
  bag.openRow = null
  replaceStreamRowAt(shell, open.index, openRowContent(open.kind, open.text, false))
}

/**
 * Grow the open row of this kind, or start one. Deltas never append a row of
 * their own — the message is a single row whose body is repainted as it fills.
 */
function growOpenRow(
  shell: AppShell,
  bag: BridgeBag,
  kind: OpenRowKind,
  text: string,
): void {
  const open = bag.openRow
  if (open !== null && open.kind === kind) {
    open.text += text
    replaceStreamRowAt(shell, open.index, openRowContent(kind, open.text, true))
    return
  }
  closeOpenRow(shell, bag)
  const index = streamRowCount(shell)
  bag.openRow = { kind, index, text }
  appendStreamRow(shell, openRowContent(kind, text, true))
}

function drainAtBoundary(shell: AppShell, bag: BridgeBag): void {
  for (;;) {
    const { state, item } = drainOne(shell.session)
    if (!item) break
    shell.session = state
    appendStreamRow(shell, {
      role: "user",
      text: userRowText(item.text, item.attachments ?? []),
      meta: item.kind === "steer" ? "steer" : "queued",
    })
    bag.pendingEchoes.push(item.text.trim())
    bag.port.deliver(item)
  }
  paintChrome(shell)
}

function applyInbound(
  shell: AppShell,
  bag: BridgeBag,
  event: BridgeInboundEvent,
): void {
  if (bag.disposed) return

  if (event.type === "assistant.delta") {
    growOpenRow(shell, bag, "assistant", event.text)
    return
  }

  if (event.type === "thinking.delta") {
    growOpenRow(shell, bag, "thinking", event.text)
    return
  }

  closeOpenRow(shell, bag)

  if (event.type === "user" && consumeEcho(bag, event.text)) return

  if (event.type === "run") {
    shell.session = setRunState(shell.session, event.state)
    paintChrome(shell)
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
  paintChrome(shell)
}

/**
 * Attach a session bridge to a shell. Operator submit/interrupt go through
 * the port; inbound events paint the transcript and drain at tool boundaries.
 */
export function attachSessionBridge(
  shell: AppShell,
  handlers?: SessionPortHandlers,
  monitor?: TurnMonitorOptions,
): SessionBridge {
  const existing = bridges.get(shell)
  if (existing) {
    existing.disposed = true
  }

  const now = monitor?.now ?? (() => Date.now())
  const stallTimeoutMs = monitor?.stallTimeoutMs ?? STALL_TIMEOUT_MS

  const bag: BridgeBag = {
    port: resolvePort(handlers),
    openRow: null,
    pendingEchoes: [],
    mapCtx: createStreamMapContext(),
    disposed: false,
    turn: initialTurnState(now()),
    lastSentMessage: "",
    quotaFired: false,
  }
  bridges.set(shell, bag)

  const paintPhase = (): void => {
    // The gate overlay is the only "blocked" signal the shell sees; the gate
    // wiring resolves approvals itself and emits no bridge event.
    const gated =
      shell.overlayKind === "permissions" || shell.overlayKind === "operator"
    const turn = gated ? turnStateBlocked(bag.turn) : bag.turn
    const input = {
      isProcessing: turn.isProcessing,
      status: turn.status,
      awaitingResponse: turn.awaitingResponse,
      currentToolName: turn.currentToolName,
      streamingType: turn.streamingType,
    }
    const label = resolveTurnLabel(input)
    if (label === undefined) {
      setTurnPhase(shell, null)
      return
    }
    // The monitor tick already re-enters here every 250 ms, so reading the
    // clock is all the animation the ramp needs — no second timer.
    const ramp = rampFor({ phase: resolveRampPhase(input), nowMs: now() })
    setTurnPhase(shell, rampLine(ramp, label))
  }

  const noteEvent = (event: { type: string; data?: unknown }): void => {
    const before = bag.turn
    bag.turn = turnStateFromEvent(bag.turn, event, now())
    // A fresh rate-limit window re-arms the single auto-retry.
    if (bag.turn.quota !== null && bag.turn.quota !== before.quota) {
      bag.quotaFired = false
    }
    paintPhase()
  }

  const handle = (event: BridgeInboundEvent | ReactorLikeEvent): void => {
    if (bag.disposed) return
    noteEvent(event)
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
    attachments?: readonly PendingImageAttachment[],
  ): void => {
    if (bag.disposed) return
    const t = text.trim()
    const attached = attachments ?? []
    if (t.length === 0 && attached.length === 0) return

    if (kind === "immediate" || shell.session.run === "idle") {
      appendStreamRow(shell, { role: "user", text: userRowText(t, attached) })
      bag.pendingEchoes.push(t)
      bag.port.sendImmediate(t, attachments)
      shell.session = setRunState(shell.session, "busy")
      bag.lastSentMessage = t
      bag.turn = turnStateOnSubmit(bag.turn, now())
      paintChrome(shell)
      paintPhase()
      return
    }

    shell.session =
      kind === "steer"
        ? enqueueSteer(shell.session, t, undefined, attachments)
        : enqueue(shell.session, t, "queue", undefined, attachments)
    bag.port.enqueue(t, kind)
    appendStreamRow(shell, {
      role: "system",
      text: `${kind} +1 → pending ${badgeCount(shell.session)}`,
      meta: "queue",
    })
    paintChrome(shell)
  }

  const doInterrupt = (): void => {
    if (bag.disposed) return
    closeOpenRow(shell, bag)
    bag.pendingEchoes.length = 0
    applyShellInterrupt(shell)
    bag.port.interrupt()
    // Clearing the last prompt is what stops the quota loop from replaying a
    // turn the operator (or the watchdog) deliberately stopped.
    bag.lastSentMessage = ""
    bag.turn = turnStateOnInterrupt(bag.turn, now())
    paintPhase()
  }

  const tick = (): void => {
    if (bag.disposed) return
    const nowMs = now()

    const quota = bag.turn.quota
    if (
      shouldAutoRetryQuota({
        quotaError: quota,
        alreadyFired: bag.quotaFired,
        nowMs,
        lastSentMessage: bag.lastSentMessage,
      })
    ) {
      bag.quotaFired = true
      const replay = bag.lastSentMessage
      bag.turn = clearQuotaWait(bag.turn)
      setStatusFlash(shell, "rate limit cleared — resubmitting")
      submit(replay, "immediate")
      return
    }

    if (quota !== null) {
      setStatusFlash(
        shell,
        `rate limited — retrying in ${quotaWaitSeconds(quota.retryAt, nowMs)}s`,
      )
      return
    }

    if (
      shouldAbortForStall({
        status: bag.turn.status,
        awaitingResponse: bag.turn.awaitingResponse,
        lastActivityAt: bag.turn.lastActivityAt,
        nowMs,
        stallTimeoutMs,
        isProcessing: bag.turn.isProcessing,
        streamingType: bag.turn.streamingType,
      })
    ) {
      applyStallRecovery({
        abort: doInterrupt,
        notify: (message) => setStatusFlash(shell, message),
      })
      return
    }

    paintPhase()
  }

  const stopMonitor =
    monitor === undefined
      ? undefined
      : (monitor.schedule ?? defaultSchedule)(
          tick,
          monitor.tickMs ?? DEFAULT_TICK_MS,
        )

  setShellBridgeHooks(shell, {
    onSubmit: (text, kind, attachments) => {
      submit(text, kind, attachments)
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
    get turn() {
      return bag.turn
    },
    dispose: () => {
      bag.disposed = true
      stopMonitor?.()
      clearShellBridgeHooks(shell)
      setTurnPhase(shell, null)
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
