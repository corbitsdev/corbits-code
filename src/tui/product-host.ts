/**
 * Production OpenTUI product host — mounts the shell with live session bridges.
 * Replaces Ink `render(<App />)` on the interactive path.
 */

import { EventEmitter } from "node:events"
import { createCliRenderer, type CliRenderer } from "@opentui/core"

import type { ApprovalOutcome, ApprovalScope, PermissionRequest } from "../permission/types.js"
import type { OperatorResult } from "../agent/tools.js"
import { createLiveSessionPort } from "./live-session-port.js"
import { checkWidthContract, widthContractNotice } from "./width-contract.js"
import {
  attachSessionBridge,
  type SessionBridge,
  type TaskProgressSession,
  type TurnMonitorOptions,
} from "./runtime-bridge.js"
import { openModelPickerOverlay } from "./overlays.js"
import { wireGates } from "./gate-wire.js"
import { createSystemClipboard } from "./system-clipboard.js"
import {
  annotateAgentTools,
  formatChromeZones,
  type ChromeLiveState,
} from "./chrome-state.js"
import {
  grantApproval,
  grantNotice,
  hookNotice,
  lifecycleHookEvent,
  mcpNotice,
  mcpServerState,
  subAgentProgress,
  RUNTIME_FLASH_MS,
  type RuntimeNotice,
} from "./runtime-notices.js"
import type { PaletteCommand } from "./command-catalog.js"
import {
  appendObserveStreamRow,
  appendStreamRow,
  clearTranscript,
  createAppShell,
  paintChrome,
  setChromeZones,
  setHeader,
  setPaletteCatalog,
  setPaletteOnCommand,
  setMcpNeedsAuth,
  setStatusFlash,
  surfaceSystemNotice,
  type AppShell,
  type ItemDescription,
  type OverlaySelection,
  type PaletteOnObserveRequest,
} from "./shell.js"
import type { QueueKind } from "./session-queue.js"
import { hydrateHistoryRows } from "./history-hydrate.js"
import type { StreamRow } from "./stream.js"

import type { PendingImageAttachment } from "./image-attachments.js"

/** Suffix the row matching `activeId` (if any) so it reads as the current pick. */
function annotateCurrent(
  rows: readonly ProductHostModelOption[],
  activeId: string | undefined,
): ProductHostModelOption[] {
  if (activeId === undefined) return [...rows]
  return rows.map((r) => (r.id === activeId ? { ...r, label: `${r.label} (current)` } : r))
}

export type ProductHostSend = (
  text: string,
  attachments?: readonly PendingImageAttachment[],
) => void
/** Classify a composer submit without side effects (see SessionPort.classifySubmit). */
export type ProductHostClassifySubmit = (
  text: string,
  attachments?: readonly PendingImageAttachment[],
) => "agent" | "local" | "empty"
export type ProductHostInterrupt = () => void
export type ProductHostDeliver = (
  text: string,
  kind: QueueKind,
  attachments?: readonly PendingImageAttachment[],
) => void

/**
 * `section` tags catalog rows for grouping/ordering in `buildModelsFirstCatalog`
 * (recent and favorites first, then provider models, then unconnected connect
 * rows). The live picker is flat + type-to-filter — it does not nest by section.
 */
export type ProductHostModelOption = {
  readonly id: string
  readonly label: string
  readonly section?: "recent" | "favorites" | "provider" | "unconnected"
}

export type ProductHostConfig = {
  readonly title: string
  /** Working directory carried by the prompt box's bottom border. */
  readonly cwd?: string
  readonly eventEmitter: EventEmitter
  readonly send: ProductHostSend
  /**
   * Classify a submit without side effects so slash commands and multi-turn
   * /feedback never mark the session busy or enter the mid-run queue.
   */
  readonly classifySubmit?: ProductHostClassifySubmit
  readonly interrupt: ProductHostInterrupt
  readonly deliver?: ProductHostDeliver
  /** Model/provider rows for the picker (id applied on select). */
  readonly models?: readonly ProductHostModelOption[]
  /**
   * Row id (`provider:model`) of the model the session is actually running,
   * read live on every picker open so it tracks selections made outside the
   * picker (e.g. `defaultProvider` at startup). Marks that row "(current)"
   * instead of guessing from the recents list.
   */
  readonly activeModelId?: () => string | undefined
  readonly onModelSelect?: (id: string) => void
  /** Description-zone source for the model picker, keyed by row id. */
  readonly describeModel?: (itemId: string) => ItemDescription | null
  /**
   * Selecting a "connect →" row (id `connect:<provider>`) calls this instead
   * of `onModelSelect`. Caller runs the connect flow and, on success, updates
   * `models`/`describeModel` via `setModels` and reopens the picker.
   */
  readonly onConnectProvider?: (providerName: string) => void
  /** Alt+F on a focused model row; connect rows are skipped by the caller. Bare `f` is claimed by type-to-filter. */
  readonly onFavoriteToggle?: (itemId: string) => void
  /** Command palette catalog (registry-backed). */
  readonly commands?: readonly PaletteCommand[]
  readonly onCommand?: (name: string) => void
  /** Optional initial chrome snapshot. */
  readonly chrome?: ChromeLiveState | null
  /**
   * Resolves the live subagent session for the palette "observe" action.
   * Unset falls back to the shell's demo fixture — production must supply
   * this to view real subagent sessions.
   */
  readonly onObserveRequest?: PaletteOnObserveRequest
  /**
   * Live sub-agent sessions read on the chrome poll cadence to refresh
   * outstanding `task` rows with elapsed time, current tool, and stall state.
   * Omitted hosts (tests, the demo shell) simply paint bare pending rows.
   */
  readonly subAgentSessions?: () => readonly TaskProgressSession[]
  /**
   * Renderer factory override for headless mounting in tests.
   * Defaults to the real `createCliRenderer`; tests inject a
   * `createTestRenderer`-backed renderer instead.
   */
  readonly createRenderer?: () => Promise<CliRenderer>
  /** Clock/timer overrides for the quota-retry and stall watchdog (tests). */
  readonly turnMonitor?: TurnMonitorOptions
  /** First-run telemetry disclosure, shown on the landing screen. */
  readonly telemetryNotice?: string
  /**
   * Take DEC mouse reporting. Default true: wheel/trackpad scroll only
   * reaches OpenTUI when the terminal is told to report it, otherwise the
   * terminal's own alternate-scroll mode resends it as arrow keys. With
   * reporting on, drag-select is OpenTUI-owned and auto-copies on mouse-up;
   * Alt+M hands the mouse back for native terminal selection.
   */
  readonly useMouse?: boolean
}

export type ProductHost = {
  readonly shell: AppShell
  readonly bridge: SessionBridge
  readonly renderer: CliRenderer
  readonly waitUntilExit: () => Promise<void>
  readonly dispose: () => void
  readonly setChrome: (state: ChromeLiveState | null) => void
  readonly setTitle: (title: string) => void
  /**
   * Push a live row into the currently open observe view.
   * No-op (returns false) when observe is not active.
   */
  readonly pushObserveRow: (row: StreamRow) => boolean
  /** Opens the model/provider picker; absent when no models were supplied. */
  readonly openModels?: () => void
  /** Swap the picker's rows/descriptions in place (e.g. after a provider connects). */
  readonly setModels?: (
    models: readonly ProductHostModelOption[],
    describeModel?: (itemId: string) => ItemDescription | null,
  ) => void
}

/** Build permission overlay rows + ApprovalOutcome table (pure; testable). */
export function permissionChoices(request: PermissionRequest): {
  items: string[]
  itemIds: string[]
  outcomes: ApprovalOutcome[]
} {
  const items: string[] = []
  const itemIds: string[] = []
  const outcomes: ApprovalOutcome[] = []

  items.push("Reject")
  itemIds.push("__deny__")
  outcomes.push({ allow: false })

  items.push("Accept once")
  itemIds.push("__once__")
  outcomes.push({ allow: true })

  for (const scope of request.scopes) {
    const label = scope.hint
      ? `${scope.label} (${scope.hint})`
      : scope.label
    items.push(label)
    itemIds.push(scope.id)
    outcomes.push({
      allow: true,
      ...(scope.pattern !== null
        ? { persist: scope as ApprovalScope }
        : {}),
    })
  }

  return { items, itemIds, outcomes }
}

/**
 * Map an overlay accept selection to OperatorResult.
 * Out-of-range index → cancel (Esc-equivalent / bad selection).
 */
export function operatorResultFromSelection(
  sel: Pick<OverlaySelection, "index">,
  optionCount: number,
): OperatorResult {
  if (sel.index < 0 || sel.index >= optionCount) {
    return { kind: "cancel" }
  }
  return { kind: "option", index: sel.index }
}

/**
 * Mount the OpenTUI shell as the production interactive UI.
 * Caller owns session lifecycle (agent, MCP, hooks); host owns paint + input.
 */
export async function mountProductHost(
  config: ProductHostConfig,
): Promise<ProductHost> {
  const renderer = config.createRenderer
    ? await config.createRenderer()
    : await createCliRenderer({
        // Leaves Ctrl+C entirely to shell.ts's own double-tap-to-quit
        // gesture (CTRL_C_EXIT_WINDOW_MS). index.ts's SIGINT handler also
        // depends on this staying false: Ctrl+C only reaches it as a real
        // OS signal when nothing already consumed it as a keypress.
        exitOnCtrlC: false,
        targetFps: 30,
        // Mouse reporting on by default: without it, wheel/trackpad scroll
        // never reaches OpenTUI — the terminal's own alternate-scroll mode
        // swallows it and resends it as arrow keys, which the prompt then
        // reads as history navigation instead of the transcript scrolling.
        // Cost accepted: this suppresses the terminal's *native* drag-select
        // in the main shell. OpenTUI selection still works and auto-copies
        // on mouse-up; Alt+M hands the mouse back when native select is wanted.
        // enableMouseMovement stays off (no ?1003): only clicks and wheel
        // are needed.
        useMouse: config.useMouse ?? true,
        enableMouseMovement: false,
        // A plain terminal sends a bare CR for both Enter and Shift+Enter, so
        // the modifier only arrives once the kitty keyboard protocol is
        // negotiated. Empty object, not explicit flags: this matches what
        // OpenCode passes, and it is the configuration Shift+Enter is known
        // to work under on the same OpenTUI renderer.
        useKittyKeyboard: {},
      })

  const shell = createAppShell(renderer, {
    title: config.title,
    clipboard: createSystemClipboard(),
    mouseCapture: {
      get: () => renderer.useMouse,
      set: (enabled: boolean) => {
        renderer.useMouse = enabled
      },
    },
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    run: "idle",
    ...(config.commands !== undefined ? { paletteCatalog: config.commands } : {}),
    ...(config.onCommand !== undefined ? { onCommand: config.onCommand } : {}),
    ...(config.onObserveRequest !== undefined
      ? { onObserveRequest: config.onObserveRequest }
      : {}),
    ...(config.telemetryNotice !== undefined
      ? { telemetryNotice: config.telemetryNotice }
      : {}),
  })

  // Announced on the notice strip (or transcript once the session has content)
  // rather than logged: a log line is invisible behind a full-screen shell, and
  // the operator is the only one who can fix a terminal setting. Using the
  // startup-notice path keeps the landing mountain painted when this fires
  // before the first turn (CL-5618).
  const widthReport = checkWidthContract(renderer.widthMethod)
  if (!widthReport.agrees) {
    surfaceSystemNotice(shell, widthContractNotice(widthReport))
  }

  const port = createLiveSessionPort({
    send: config.send,
    interrupt: config.interrupt,
    ...(config.classifySubmit !== undefined
      ? { classifySubmit: config.classifySubmit }
      : {}),
    ...(config.deliver !== undefined ? { deliver: config.deliver } : {}),
  })
  // Empty options accept the defaults (real clock, 250 ms tick, 15 min stall)
  // while still opting this host into the quota-retry / stall timers.
  const bridge = attachSessionBridge(shell, port, config.turnMonitor ?? {})

  if (config.commands !== undefined && config.commands.length > 0) {
    setPaletteCatalog(shell, config.commands)
  }
  if (config.onCommand) {
    setPaletteOnCommand(shell, config.onCommand)
  }

  // Live chrome is pushed by the caller; subagent progress annotates the copy
  // the host last received rather than racing the caller for the zone.
  let chromeState: ChromeLiveState | null = config.chrome ?? null
  const subAgentTools = new Map<string, string>()
  const paintChromeZones = (): void => {
    if (chromeState === null) {
      setChromeZones(shell, { task: null, agents: null })
      return
    }
    setChromeZones(
      shell,
      formatChromeZones(annotateAgentTools(chromeState, subAgentTools)),
    )
  }
  if (chromeState !== null) paintChromeZones()

  let disposed = false
  let resolveExit: (() => void) | undefined
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve
  })

  // The poll outlives the renderer whenever a caller tears the renderer down
  // without disposing the host. Painting into freed buffers throws, and a host
  // that can no longer paint has nothing left to keep fresh, so it stands down.
  const stickyPoll = setInterval(() => {
    if (disposed) return
    try {
      paintChrome(shell)
      if (config.subAgentSessions !== undefined) {
        bridge.syncAgentProgress(config.subAgentSessions())
      }
      // The agents panel's elapsed clock and stalled flag are a function of
      // wall time, not just of the last event — repaint on the same tick as
      // the transcript trailer so a worker that goes quiet still flips to
      // "stalled" without waiting on an unrelated chrome push. Gated on a
      // running agent existing: paintChromeZones() re-enters setChromeZones,
      // which already calls paintChrome(shell) on its own unchanged-zone
      // path, so calling it unconditionally would repaint chrome twice a
      // tick for the common case (task only, no agents) that has nothing
      // time-based to refresh.
      if (chromeState !== null && (chromeState.agents ?? []).some((a) => a.status === "running")) {
        paintChromeZones()
      }
    } catch {
      clearInterval(stickyPoll)
    }
  }, 200)
  if (typeof stickyPoll.unref === "function") stickyPoll.unref()

  function dispose(): void {
    if (disposed) return
    disposed = true
    clearInterval(stickyPoll)
    config.eventEmitter.off("event", onEvent)
    disposeGates()
    config.eventEmitter.off("history.hydrate", onHistory)
    config.eventEmitter.off("session.title", onTitle)
    config.eventEmitter.off("session.clear", onSessionClear)
    config.eventEmitter.off("hook", onHook)
    config.eventEmitter.off("mcp.status", onMcpStatus)
    config.eventEmitter.off("permission.grant", onPermissionGrant)
    config.eventEmitter.off("subagent.progress", onSubAgentProgress)
    bridge.dispose()
    // Cancels any flash still counting down: its expiry repaints, and after
    // teardown that repaint reaches a destroyed text buffer.
    setStatusFlash(shell, null)
    try {
      shell.dispose()
    } catch {
      // already torn down
    }
    try {
      renderer.destroy()
    } catch {
      // already destroyed
    }
    resolveExit?.()
  }

  // Servers that announced an authorization URL and have not connected since.
  const mcpUnauthorized = new Set<string>()

  function onEvent(event: unknown): void {
    if (disposed) return
    if (
      event !== null &&
      typeof event === "object" &&
      "type" in event &&
      typeof (event as { type: unknown }).type === "string"
    ) {
      bridge.handle(event as { type: string; data?: unknown })
    }
  }

  function show(notice: RuntimeNotice | null): void {
    if (notice === null) return
    if (notice.kind === "row") {
      // MCP load failures and hook failures must not wipe the landing mark.
      // surfaceSystemNotice keeps the mountain while the notice strip carries
      // the wording, then flushes a durable row once the session starts.
      surfaceSystemNotice(shell, notice.text)
      return
    }
    setStatusFlash(shell, notice.text, { ttlMs: RUNTIME_FLASH_MS })
  }

  function onHook(event: unknown): void {
    if (disposed) return
    const parsed = lifecycleHookEvent(event)
    if (parsed !== null) show(hookNotice(parsed))
  }

  function onMcpStatus(state: unknown): void {
    if (disposed) return
    const parsed = mcpServerState(state)
    if (parsed === null) return
    if (parsed.state === "needs-auth") mcpUnauthorized.add(parsed.name)
    else mcpUnauthorized.delete(parsed.name)
    setMcpNeedsAuth(shell, [...mcpUnauthorized])
    show(mcpNotice(parsed))
  }

  function onPermissionGrant(payload: unknown): void {
    if (disposed) return
    const approval = grantApproval(payload)
    if (approval !== null) show(grantNotice(approval))
  }

  function onSubAgentProgress(info: unknown): void {
    if (disposed) return
    const progress = subAgentProgress(info)
    if (progress === null) return
    subAgentTools.set(progress.description, progress.toolName)
    paintChromeZones()
  }

  // The renderer already owns the alternate screen and raw mode by this point,
  // but `dispose` has not been handed to any caller yet — a throw here would
  // leave the terminal wedged with nobody able to restore it.
  let disposeGates: () => void
  try {
    disposeGates = wireGates(config.eventEmitter, shell, {
      onGateOpened: () => bridge.gateOpened(),
      onGateClosed: () => bridge.gateClosed(),
    })
  } catch (err: unknown) {
    try {
      renderer.destroy()
    } catch {
      // already destroyed
    }
    throw err
  }

  function onHistory(blocks: unknown): void {
    if (disposed) return
    for (const row of hydrateHistoryRows(blocks)) {
      appendStreamRow(shell, row)
    }
  }

  function onTitle(title: unknown): void {
    if (typeof title === "string" && title.length > 0) {
      setHeader(shell, title)
    }
  }

  // /clear and /new rotate the backend session in the runner; the host must
  // wipe the painted transcript so the screen matches a brand-new session.
  // The Ink App used to own this unconditionally — OpenTUI regressed it.
  function onSessionClear(): void {
    if (disposed) return
    clearTranscript(shell)
  }

  let currentModels = config.models ?? []
  let currentDescribeModel = config.describeModel
  let openModels: (() => void) | undefined
  if (config.onModelSelect) {
    const onSelect = config.onModelSelect
    const onConnect = config.onConnectProvider
    const onFavoriteToggle = config.onFavoriteToggle

    openModels = (): void => {
      const activeId = config.activeModelId?.()
      const items = annotateCurrent(currentModels, activeId)
      openModelPickerOverlay(shell, {
        items: items.map((m) => m.label),
        itemIds: items.map((m) => m.id),
        // Flat list: type to narrow rather than drill into a provider pane.
        typeToFilter: true,
        onAccept: (sel) => {
          // Prefer the stable id from the (possibly filtered) row. Do not fall
          // back to `items[sel.index]` — that index is into the filtered list,
          // not the unfiltered catalog, so it would pick the wrong model.
          const id = sel.id
          if (id === undefined || id.length === 0) return
          const providerName = id.startsWith("connect:") ? id.slice("connect:".length) : null
          if (providerName !== null) {
            onConnect?.(providerName)
            return
          }
          onSelect(id)
        },
        describe: (itemId) => currentDescribeModel?.(itemId) ?? null,
        ...(onFavoriteToggle !== undefined
          ? {
              onAction: (itemId, key) => {
                // Alt+F, never bare f — type-to-filter claims printable keys.
                const name = typeof key.name === "string" ? key.name.toLowerCase() : ""
                if (name !== "f" || key.ctrl || !(key.meta || key.option)) return false
                // Empty id is the "(no matches)" filter sentinel — not a model.
                if (itemId.length === 0 || itemId.startsWith("connect:")) return false
                onFavoriteToggle(itemId)
                return true
              },
            }
          : {}),
      })
    }
  }
  const setModels = (
    models: readonly ProductHostModelOption[],
    describeModel?: (itemId: string) => ItemDescription | null,
  ): void => {
    currentModels = models
    currentDescribeModel = describeModel
  }

  config.eventEmitter.on("event", onEvent)
  config.eventEmitter.on("history.hydrate", onHistory)
  config.eventEmitter.on("session.title", onTitle)
  config.eventEmitter.on("session.clear", onSessionClear)
  config.eventEmitter.on("hook", onHook)
  config.eventEmitter.on("mcp.status", onMcpStatus)
  config.eventEmitter.on("permission.grant", onPermissionGrant)
  config.eventEmitter.on("subagent.progress", onSubAgentProgress)

  return {
    shell,
    bridge,
    renderer,
    waitUntilExit: () => exitPromise,
    dispose,
    setChrome: (state) => {
      chromeState = state ?? null
      paintChromeZones()
    },
    setTitle: (title) => setHeader(shell, title),
    pushObserveRow: (row) => appendObserveStreamRow(shell, row),
    ...(openModels !== undefined ? { openModels, setModels } : {}),
  }
}
