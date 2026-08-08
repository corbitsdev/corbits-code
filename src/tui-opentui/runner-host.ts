/**
 * Runner-facing mount for the OpenTUI product host.
 *
 * Owns everything renderer-specific about the interactive path so the session
 * runner keeps only agent/session wiring: catalog assembly from live config,
 * chrome pushes on session change, subagent observe resolution, and the quit
 * key that resolves `waitUntilExit`.
 */

import type { EventEmitter } from "node:events"
import type { CliRenderer, KeyEvent } from "@opentui/core"

import type { SubAgentSession, SubAgentTranscriptEntry } from "../subagent/session-store.js"
import { buildCommandCatalog, type RegistryCommandSource } from "./command-catalog.js"
import {
  openCommandSurface,
  type CommandSurfaceDeps,
  type CommandSurfaceKind,
} from "./command-surfaces.js"
import { chromeFromSession, type ChromeSessionInput } from "./chrome-state.js"
import {
  buildModelsFirstCatalog,
  describeModelCatalogOption,
  modelOptionId,
  type ModelCatalogOption,
  type ModelCatalogProvidersInput,
  type ModelCatalogRef,
  type ModelCatalogUnconnectedProvider,
} from "./model-catalog.js"
import type { ItemDescription } from "./shell.js"
import { mountProductHost, type ProductHost } from "./product-host.js"
import { onTurnBoundary } from "../agent/reactor-events.js"
import {
  clearShellExitHandler,
  setPromptCostContext,
  setPromptModelLabel,
  setPromptWorkspace,
  setShellExitHandler,
  surfaceStartupNotice,
} from "./shell.js"
import type { CostSummary } from "../cost/cost-summary.js"
import { watchGitBranch, type FetchBranch } from "./workspace-watch.js"
import type { PromptActionBarModelLabelInput } from "../tui/components/prompt-action-bar-label.js"
import type { ObserveSession } from "./residuals.js"
import type { PendingImageAttachment } from "../tui/image-attachments.js"
import { toolCallRow } from "./diff.js"
import { toolResultRow } from "./mcp-view.js"
import { pushToolCall, pushToolResult } from "./tool-rows.js"
import type { StreamRow } from "./stream.js"
import type { QueueKind } from "./session-queue.js"

export type RunnerHostDeps = {
  readonly title: string
  readonly eventEmitter: EventEmitter
  readonly send: (
    text: string,
    attachments?: readonly PendingImageAttachment[],
  ) => void
  readonly interrupt: () => void
  readonly deliver?: (
    text: string,
    kind: QueueKind,
    attachments?: readonly PendingImageAttachment[],
  ) => void
  readonly providers: ModelCatalogProvidersInput
  /** Recently used provider+model pairs, most recent first (settings.recentModels). */
  readonly recentModels?: readonly ModelCatalogRef[]
  /** Favorited provider+model pairs (settings.favoriteModels). */
  readonly favoriteModels?: readonly ModelCatalogRef[]
  /** Known providers with no stored credentials yet — rendered as "connect →" rows. */
  readonly unconnectedProviders?: readonly ModelCatalogUnconnectedProvider[]
  /**
   * Provider+model the session is actually running, read live on every
   * picker open. Marks that row "(current)" — independent of recents, which
   * only move on an explicit `/model` pick and can go stale.
   */
  readonly activeModel?: () => ModelCatalogRef | undefined
  readonly onModelSelect: (id: string) => void
  /** Selecting a "connect →" row; runner owns the actual connect flow. */
  readonly onConnectProvider?: (providerName: string) => void
  /** `f` on a focused model row; runner owns the favorite persist + refresh. */
  readonly onFavoriteToggle?: (id: string) => void
  /** Working directory carried by the prompt box's bottom border. */
  readonly cwd?: string
  /** Branch lookup override for tests; defaults to a real `git rev-parse`. */
  readonly fetchBranch?: FetchBranch
  /**
   * Live `profile · model · effort` source for the top border label. Read on
   * mount and again after every model selection, so the label follows the
   * same config the picker mutates.
   */
  readonly modelLabel?: () => PromptActionBarModelLabelInput
  /**
   * Live cost/context source for the bottom border's meter. Read on mount and
   * again after every completed inference turn, so the meter tracks usage
   * without a timer of its own.
   */
  readonly readCostSummary?: () => CostSummary | undefined
  /**
   * Live read of the show-cost setting. Consulted on every cost push so the
   * cost run is omitted at the source when off, rather than composed and
   * then hidden. Defaults to false (off) when omitted.
   */
  readonly showPromptCost?: () => boolean
  readonly commands: readonly RegistryCommandSource[]
  readonly onCommand: (name: string) => void
  /** Live chrome snapshot source, read on mount and on every notify. */
  readonly chrome: () => ChromeSessionInput
  /** Registers a chrome-change notifier; returns an unsubscribe. */
  readonly subscribeChrome?: (notify: () => void) => () => void
  /** Live subagent sessions for the palette observe action. */
  readonly subAgentSessions: () => readonly SubAgentSession[]
  /**
   * Live data behind the command surfaces (settings, permissions, plugins).
   * `notify` is supplied by the host itself.
   */
  readonly surfaces?: Omit<CommandSurfaceDeps, "notify" | "openModels">
  /** Renderer factory override for headless mounting in tests. */
  readonly createRenderer?: () => Promise<CliRenderer>
  /** First-run telemetry disclosure, shown on the landing screen. */
  readonly telemetryNotice?: string
}

/** Product host plus the runner-owned subscriptions torn down with it. */
export type RunnerHost = ProductHost & {
  /**
   * Open a command surface. Returns false when the requested surface has no
   * OpenTUI implementation, so the caller can report the gap.
   */
  readonly openSurface: (kind: CommandSurfaceKind) => boolean
  /**
   * Recompute the models-first catalog from fresh recent/favorite refs and
   * push it into the already-open host — the picker's Recent/Favorites
   * sections would otherwise never reflect a same-session selection.
   *
   * `providers`/`unconnected` default to the values last passed here (or the
   * mount-time deps) — pass fresh ones after a live provider connect so a
   * newly authorized provider's models appear without a restart.
   */
  readonly refreshModels: (
    recentModels: readonly ModelCatalogRef[],
    favoriteModels: readonly ModelCatalogRef[],
    providers?: ModelCatalogProvidersInput,
    unconnected?: readonly ModelCatalogUnconnectedProvider[],
  ) => void
  /** Re-reads `showPromptCost` and cost/context state, repainting the border immediately. */
  readonly refreshCostContext: () => void
}

/** Map a subagent transcript entry to a stream row. */
export function rowFromTranscriptEntry(entry: SubAgentTranscriptEntry): StreamRow {
  switch (entry.kind) {
    case "text":
      return { role: "assistant", text: entry.content }
    case "thinking":
      return { role: "system", text: entry.content, meta: "thinking" }
    case "tool":
      return toolCallRow({ name: entry.name, arguments: entry.arguments, callId: entry.callId })
    case "tool_result":
      return toolResultRow({
        name: entry.name,
        content: entry.content,
        isError: entry.isError,
        callId: entry.callId,
      })
    case "report":
      return { role: "assistant", text: entry.content, meta: "report" }
  }
}

/**
 * A subagent transcript as rows. Tool entries are folded, not mapped one to
 * one: a call and its result share a row, and a repeated call collapses onto
 * the row it repeats.
 */
export function rowsFromTranscript(
  entries: readonly SubAgentTranscriptEntry[],
): StreamRow[] {
  const rows: StreamRow[] = []
  for (const entry of entries) {
    if (entry.kind === "tool") {
      pushToolCall(rows, { name: entry.name, arguments: entry.arguments, callId: entry.callId })
      continue
    }
    if (entry.kind === "tool_result") {
      pushToolResult(rows, {
        name: entry.name,
        content: entry.content,
        isError: entry.isError,
        callId: entry.callId,
      })
      continue
    }
    rows.push(rowFromTranscriptEntry(entry))
  }
  return rows
}

/**
 * Pick the session the operator most likely wants to watch: the newest running
 * one, else the most recent session of any status. No sessions → null.
 */
export function observeSessionFromSubAgents(
  sessions: readonly SubAgentSession[],
): ObserveSession | null {
  const running = [...sessions].reverse().find((s) => s.status === "running")
  const picked = running ?? sessions[sessions.length - 1]
  if (picked === undefined) return null
  return {
    sessionId: picked.id,
    agentId: picked.agentId,
    description: picked.description,
    lines: rowsFromTranscript(picked.entries),
  }
}

/** Mount the OpenTUI host for a live session. */
export async function mountRunnerHost(deps: RunnerHostDeps): Promise<RunnerHost> {
  // Mutable so a live provider connect (see refreshModels below) can replace
  // the catalog source without remounting the host.
  let liveProviders = deps.providers
  let liveUnconnected = deps.unconnectedProviders ?? []
  let catalog: readonly ModelCatalogOption[] = buildModelsFirstCatalog({
    providers: liveProviders,
    recent: deps.recentModels ?? [],
    favorites: deps.favoriteModels ?? [],
    unconnected: liveUnconnected,
  })
  const describeModel = (itemId: string): ItemDescription | null =>
    describeModelCatalogOption(
      catalog.find((o) => o.id === itemId) ?? { id: itemId, label: itemId },
      { unconnected: liveUnconnected },
    )
  const readModelLabel = deps.modelLabel
  const onModelSelect = (id: string): void => {
    deps.onModelSelect(id)
    if (readModelLabel) setPromptModelLabel(host.shell, readModelLabel())
  }
  const cwd = deps.cwd ?? process.cwd()
  const host = await mountProductHost({
    title: deps.title,
    cwd,
    eventEmitter: deps.eventEmitter,
    send: deps.send,
    interrupt: deps.interrupt,
    ...(deps.deliver !== undefined ? { deliver: deps.deliver } : {}),
    ...(deps.onConnectProvider !== undefined
      ? { onConnectProvider: deps.onConnectProvider }
      : {}),
    ...(deps.onFavoriteToggle !== undefined
      ? { onFavoriteToggle: deps.onFavoriteToggle }
      : {}),
    models: catalog,
    activeModelId: () => {
      const active = deps.activeModel?.()
      return active ? modelOptionId(active.provider, active.model) : undefined
    },
    onModelSelect,
    describeModel,
    commands: buildCommandCatalog(deps.commands),
    onCommand: deps.onCommand,
    chrome: chromeFromSession(deps.chrome()),
    onObserveRequest: () => observeSessionFromSubAgents(deps.subAgentSessions()),
    subAgentSessions: () =>
      deps.subAgentSessions().map((s) => ({
        id: s.id,
        status: s.status,
        currentToolName: s.currentToolName,
        startedAt: s.startedAt,
        lastActivityAt: s.lastActivityAt,
      })),
    ...(deps.createRenderer !== undefined ? { createRenderer: deps.createRenderer } : {}),
    ...(deps.telemetryNotice !== undefined
      ? { telemetryNotice: deps.telemetryNotice }
      : {}),
  })

  const pushChrome = (): void => {
    host.setChrome(chromeFromSession(deps.chrome()))
  }
  const unsubscribeChrome = deps.subscribeChrome?.(pushChrome)

  if (readModelLabel) setPromptModelLabel(host.shell, readModelLabel())

  const pushCostContext = (): void => {
    const summary = deps.readCostSummary?.()
    if (summary === undefined) return
    const showCost = deps.showPromptCost?.() ?? false
    setPromptCostContext(host.shell, {
      contextPercentUsed: summary.contextPercentUsed,
      costLabel: showCost && summary.costHiddenReason === null ? summary.formattedCost : null,
      contextIsEstimate: summary.contextIsEstimate,
    })
  }
  pushCostContext()
  // Every completed inference turn changes both cost and context usage;
  // nothing else needs a fresher read than that.
  const onCostEvent = (event: { type: string }): void => {
    if (onTurnBoundary(event)) pushCostContext()
  }
  deps.eventEmitter.on("event", onCostEvent)

  const stopBranchWatch = watchGitBranch({
    cwd,
    onBranch: (branch) => setPromptWorkspace(host.shell, { branch }),
    ...(deps.fetchBranch !== undefined ? { fetchBranch: deps.fetchBranch } : {}),
  })

  // Quitting is Ctrl+C twice, the binding this interface has always used. The
  // host claims no key of its own: a second exit chord split the one thing
  // every operator already knows across two keys, and Ctrl+D stays the
  // prompt's delete-character-under-cursor.

  const dispose = (): void => {
    stopBranchWatch()
    deps.eventEmitter.off("event", onCostEvent)
    unsubscribeChrome?.()
    clearShellExitHandler(host.shell)
    host.dispose()
  }

  // A bare `exit` / `quit` at the prompt routes through the same teardown as
  // the Ctrl+C exit, so finalize still runs.
  setShellExitHandler(host.shell, dispose)

  const surfaceDeps: CommandSurfaceDeps = {
    ...(deps.surfaces ?? {}),
    ...(host.openModels !== undefined ? { openModels: host.openModels } : {}),
    notify: (text) => surfaceStartupNotice(host.shell, text),
  }

  const refreshModels = (
    recentModels: readonly ModelCatalogRef[],
    favoriteModels: readonly ModelCatalogRef[],
    providers?: ModelCatalogProvidersInput,
    unconnected?: readonly ModelCatalogUnconnectedProvider[],
  ): void => {
    if (providers !== undefined) liveProviders = providers
    if (unconnected !== undefined) liveUnconnected = unconnected
    catalog = buildModelsFirstCatalog({
      providers: liveProviders,
      recent: recentModels,
      favorites: favoriteModels,
      unconnected: liveUnconnected,
    })
    host.setModels?.(catalog, describeModel)
  }

  return {
    ...host,
    dispose,
    openSurface: (kind) => openCommandSurface(host.shell, kind, surfaceDeps),
    refreshModels,
    refreshCostContext: pushCostContext,
  }
}
