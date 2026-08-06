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
} from "./runtime-bridge.js"
import {
  openModelPickerOverlay,
  openOperatorOverlay,
  openPermissionsOverlay,
} from "./overlays.js"
import { formatChromeZones, type ChromeLiveState } from "./chrome-state.js"
import type { PaletteCommand } from "./palette.js"
import {
  appendStreamRow,
  createAppShell,
  paintStatus,
  setChromeZones,
  setHeader,
  setPaletteCatalog,
  setPaletteOnCommand,
  type AppShell,
  type OverlaySelection,
} from "./shell.js"
import type { QueueKind } from "./session-queue.js"
import type { StreamRow } from "./stream.js"

export type ProductHostSend = (text: string) => void
export type ProductHostInterrupt = () => void
export type ProductHostDeliver = (text: string, kind: QueueKind) => void

export type ProductHostModelOption = {
  readonly id: string
  readonly label: string
}

export type ProductHostConfig = {
  readonly title: string
  readonly eventEmitter: EventEmitter
  readonly send: ProductHostSend
  readonly interrupt: ProductHostInterrupt
  readonly deliver?: ProductHostDeliver
  /** Model/provider rows for the picker (id applied on select). */
  readonly models?: readonly ProductHostModelOption[]
  readonly onModelSelect?: (id: string) => void
  /** Command palette catalog (registry-backed). */
  readonly commands?: readonly PaletteCommand[]
  readonly onCommand?: (name: string) => void
  /** Optional initial chrome snapshot. */
  readonly chrome?: ChromeLiveState | null
}

export type ProductHost = {
  readonly shell: AppShell
  readonly bridge: SessionBridge
  readonly renderer: CliRenderer
  readonly waitUntilExit: () => Promise<void>
  readonly dispose: () => void
  readonly setChrome: (state: ChromeLiveState | null) => void
  readonly setTitle: (title: string) => void
}

type PermissionGateEvent = {
  request: PermissionRequest
  resolve: (outcome: ApprovalOutcome) => void
}

type OperatorGateEvent = {
  question: string
  options: string[]
  resolve: (result: OperatorResult) => void
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
      return {
        role: "tool",
        text: block.content ?? "…",
        meta: block.name ?? "tool",
      }
    case "tool_result":
      return {
        role: "tool",
        text: block.content ?? (block.isError ? "error" : "ok"),
        meta: block.isError
          ? `${block.name ?? "tool"}!`
          : (block.name ?? "tool"),
      }
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
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
  })

  const shell = createAppShell(renderer, {
    title: config.title,
    run: "idle",
    ...(config.commands !== undefined ? { paletteCatalog: config.commands } : {}),
    ...(config.onCommand !== undefined ? { onCommand: config.onCommand } : {}),
  })

  const port = createLiveSessionPort({
    send: config.send,
    interrupt: config.interrupt,
    ...(config.deliver !== undefined ? { deliver: config.deliver } : {}),
  })
  const bridge = attachSessionBridge(shell, port)

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
    if (!disposed) paintStatus(shell)
  }, 200)

  function dispose(): void {
    if (disposed) return
    disposed = true
    clearInterval(stickyPoll)
    config.eventEmitter.off("event", onEvent)
    config.eventEmitter.off("permission.gate", onPermission)
    config.eventEmitter.off("operator.gate", onOperator)
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

  function onPermission(ev: PermissionGateEvent): void {
    if (disposed) return
    const { items, itemIds, outcomes } = permissionChoices(ev.request)
    const body = [
      ev.request.tool,
      ev.request.action,
      ev.request.subject,
      ev.request.agentLabel ? `agent: ${ev.request.agentLabel}` : "",
      ev.request.notice ?? "",
    ]
      .filter((l) => l.length > 0)
      .join("\n")

    openPermissionsOverlay(shell, {
      items,
      itemIds,
      onAccept: (sel: OverlaySelection) => {
        const outcome = outcomes[sel.index] ?? { allow: false }
        ev.resolve(outcome)
      },
    })
    if (body.length > 0) {
      appendStreamRow(shell, {
        role: "system",
        text: body.slice(0, 500),
        meta: "permission",
      })
    }
  }

  function onOperator(ev: OperatorGateEvent): void {
    if (disposed) return
    openOperatorOverlay(shell, {
      body: ev.question,
      choices: ev.options,
      itemIds: ev.options.map((_, i) => String(i)),
      onAccept: (sel: OverlaySelection) => {
        ev.resolve(operatorResultFromSelection(sel, ev.options.length))
      },
    })
  }

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

  if (config.models && config.models.length > 0 && config.onModelSelect) {
    const models = config.models
    const onSelect = config.onModelSelect
    const openModels = (): void => {
      openModelPickerOverlay(shell, {
        items: models.map((m) => m.label),
        itemIds: models.map((m) => m.id),
        onAccept: (sel) => {
          const id = sel.id ?? models[sel.index]?.id
          if (id) onSelect(id)
        },
      })
    }
    ;(shell as AppShell & { __openModels?: () => void }).__openModels =
      openModels
  }

  config.eventEmitter.on("event", onEvent)
  config.eventEmitter.on("permission.gate", onPermission)
  config.eventEmitter.on("operator.gate", onOperator)
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
  }
}
