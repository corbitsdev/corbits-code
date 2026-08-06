/**
 * Production OpenTUI product host — mounts the shell with live session bridges.
 * Replaces Ink `render(<App />)` on the interactive path.
 */

import { EventEmitter } from "node:events"
import { createCliRenderer, type CliRenderer } from "@opentui/core"

import type { ApprovalOutcome, ApprovalScope, PermissionRequest } from "../permission/types.js"
import type { OperatorResult } from "../agent/tools.js"
import { createLiveSessionPort } from "./live-session-port.js"
import {
  attachSessionBridge,
  type SessionBridge,
  type TurnMonitorOptions,
} from "./runtime-bridge.js"
import { openModelPickerOverlay } from "./overlays.js"
import { wireGates } from "./gate-wire.js"
import { formatChromeZones, type ChromeLiveState } from "./chrome-state.js"
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
  type AppShell,
  type ItemDescription,
  type OverlaySelection,
  type PaletteOnObserveRequest,
} from "./shell.js"
import type { QueueKind } from "./session-queue.js"
import { toolCallRow } from "./diff.js"
import { toolResultRow } from "./mcp-view.js"
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

/** Map history hydrate blocks → stream rows (pure; testable). */
export function rowFromHistoryBlock(block: {
  type: string
  content?: string
  name?: string
  message?: string
  isError?: boolean
}): StreamRow | null {
  switch (block.type) {
    case "user":
      return { role: "user", text: block.content ?? "" }
    case "text":
    case "reply":
      return { role: "assistant", text: block.content ?? "" }
    case "thinking":
      return { role: "system", text: block.content ?? "", meta: "thinking" }
    case "tool_call":
      return toolCallRow({
        name: block.name ?? "tool",
        ...(block.content !== undefined ? { arguments: block.content } : {}),
      })
    case "tool_result":
      return toolResultRow({
        name: block.name ?? "tool",
        content: block.content ?? (block.isError ? "error" : "ok"),
        isError: block.isError === true,
      })
    case "error":
      return { role: "system", text: block.message ?? "error", meta: "error" }
    default:
      return null
  }
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
      })

  const shell = createAppShell(renderer, {
    title: config.title,
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

  if (config.chrome) {
    setChromeZones(shell, formatChromeZones(config.chrome))
  }

  let disposed = false
  let resolveExit: (() => void) | undefined
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve
  })

  const stickyPoll = setInterval(() => {
    if (!disposed) paintChrome(shell)
  }, 200)

  function dispose(): void {
    if (disposed) return
    disposed = true
    clearInterval(stickyPoll)
    config.eventEmitter.off("event", onEvent)
    disposeGates()
    config.eventEmitter.off("history.hydrate", onHistory)
    config.eventEmitter.off("session.title", onTitle)
    bridge.dispose()
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

  const disposeGates = wireGates(config.eventEmitter, shell)

  function onHistory(blocks: unknown): void {
    if (disposed || !Array.isArray(blocks)) return
    for (const raw of blocks) {
      if (raw === null || typeof raw !== "object") continue
      const row = rowFromHistoryBlock(
        raw as {
          type: string
          content?: string
          name?: string
          message?: string
          isError?: boolean
        },
      )
      if (row) appendStreamRow(shell, row)
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

  return {
    shell,
    bridge,
    renderer,
    waitUntilExit: () => exitPromise,
    dispose,
    setChrome: (state) => {
      if (state) setChromeZones(shell, formatChromeZones(state))
      else setChromeZones(shell, { goal: null, task: null, agents: null })
    },
    setTitle: (title) => setHeader(shell, title),
    pushObserveRow: (row) => appendObserveStreamRow(shell, row),
    ...(openModels !== undefined ? { openModels, setModels } : {}),
  }
}
