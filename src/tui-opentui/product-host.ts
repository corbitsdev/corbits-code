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
import type { PaletteCommand } from "./palette.js"
import {
  appendObserveStreamRow,
  appendStreamRow,
  createAppShell,
  paintChrome,
  setChromeZones,
  setHeader,
  setPaletteCatalog,
  setPaletteOnCommand,
  setMcpNeedsAuth,
  setStatusFlash,
  type AppShell,
  type ItemDescription,
  type OverlaySelection,
  type PaletteOnObserveRequest,
} from "./shell.js"
import type { QueueKind } from "./session-queue.js"
import { hydrateHistoryRows } from "./history-hydrate.js"
import type { StreamRow } from "./stream.js"

import type { PendingImageAttachment } from "../tui/image-attachments.js"

export type ProductHostSend = (
  text: string,
  attachments?: readonly PendingImageAttachment[],
) => void
export type ProductHostInterrupt = () => void
export type ProductHostDeliver = (
  text: string,
  kind: QueueKind,
  attachments?: readonly PendingImageAttachment[],
) => void

export type ProductHostModelOption = {
  readonly id: string
  readonly label: string
}

export type ProductHostConfig = {
  readonly title: string
  /** Working directory carried by the prompt box's bottom border. */
  readonly cwd?: string
  readonly eventEmitter: EventEmitter
  readonly send: ProductHostSend
  readonly interrupt: ProductHostInterrupt
  readonly deliver?: ProductHostDeliver
  /** Model/provider rows for the picker (id applied on select). */
  readonly models?: readonly ProductHostModelOption[]
  readonly onModelSelect?: (id: string) => void
  /** Description-zone source for the model picker, keyed by row id. */
  readonly describeModel?: (itemId: string) => ItemDescription | null
  /**
   * Selecting a "connect →" row (id `connect:<provider>`) calls this instead
   * of `onModelSelect`. Caller runs the connect flow and, on success, updates
   * `models`/`describeModel` via `setModels` and reopens the picker.
   */
  readonly onConnectProvider?: (providerName: string) => void
  /** `f` on a focused model/provider row; absent rows (connect →) are skipped by the caller. */
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
   * terminal's own alternate-scroll mode resends it as arrow keys. Alt+M
   * hands the mouse back to the terminal for native drag-select.
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
        exitOnCtrlC: false,
        targetFps: 30,
        // Mouse reporting on by default: without it, wheel/trackpad scroll
        // never reaches OpenTUI — the terminal's own alternate-scroll mode
        // swallows it and resends it as arrow keys, which the prompt then
        // reads as history navigation instead of the transcript scrolling.
        // Cost accepted: this suppresses the terminal's native drag-select
        // in the main shell. Alt+M hands the mouse back when that is wanted.
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

  // Announced in the transcript rather than logged: a log line is invisible
  // behind a full-screen shell, and the operator is the only one who can fix a
  // terminal setting.
  const widthReport = checkWidthContract(renderer.widthMethod)
  if (!widthReport.agrees) {
    appendStreamRow(shell, { role: "system", text: widthContractNotice(widthReport) })
  }

  const port = createLiveSessionPort({
    send: config.send,
    interrupt: config.interrupt,
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
      setChromeZones(shell, { goal: null, task: null, agents: null })
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
      appendStreamRow(shell, { role: "system", text: notice.text })
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
    disposeGates = wireGates(config.eventEmitter, shell)
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

  let currentModels = config.models ?? []
  let currentDescribeModel = config.describeModel
  let openModels: (() => void) | undefined
  if (config.onModelSelect) {
    const onSelect = config.onModelSelect
    const onConnect = config.onConnectProvider
    const onFavoriteToggle = config.onFavoriteToggle
    openModels = (): void => {
      openModelPickerOverlay(shell, {
        items: currentModels.map((m) => m.label),
        itemIds: currentModels.map((m) => m.id),
        onAccept: (sel) => {
          const id = sel.id ?? currentModels[sel.index]?.id
          if (!id) return
          const providerName = id.startsWith("connect:") ? id.slice("connect:".length) : null
          if (providerName !== null) {
            onConnect?.(providerName)
            return
          }
          onSelect(id)
        },
        ...(currentDescribeModel !== undefined ? { describe: currentDescribeModel } : {}),
        ...(onFavoriteToggle !== undefined
          ? {
              onAction: (itemId, key) => {
                // Alt+F, never bare f — the palette filters as you type, so a
                // bare letter narrows the list instead of toggling a favorite.
                const name = typeof key.name === "string" ? key.name.toLowerCase() : ""
                if (name !== "f" || key.ctrl || !(key.meta || key.option)) return false
                if (itemId.startsWith("connect:")) return false
                onFavoriteToggle(itemId)
                return true
              },
            }
          : {}),
      })
    }
    ;(shell as AppShell & { __openModels?: () => void }).__openModels =
      openModels
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
