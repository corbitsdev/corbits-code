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
import { buildModelCatalog, type ModelCatalogProvidersInput } from "./model-catalog.js"
import { mountProductHost, type ProductHost } from "./product-host.js"
import { appendStreamRow } from "./shell.js"
import type { ObserveSession } from "./residuals.js"
import type { StreamRow } from "./stream.js"
import type { QueueKind } from "./session-queue.js"

export type RunnerHostDeps = {
  readonly title: string
  readonly eventEmitter: EventEmitter
  readonly send: (text: string) => void
  readonly interrupt: () => void
  readonly deliver?: (text: string, kind: QueueKind) => void
  readonly providers: ModelCatalogProvidersInput
  readonly onModelSelect: (id: string) => void
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
}

/** Product host plus the runner-owned subscriptions torn down with it. */
export type RunnerHost = ProductHost & {
  /**
   * Open a command surface. Returns false when the requested surface has no
   * OpenTUI implementation, so the caller can report the gap.
   */
  readonly openSurface: (kind: CommandSurfaceKind) => boolean
}

/** Map a subagent transcript entry to a stream row. */
export function rowFromTranscriptEntry(entry: SubAgentTranscriptEntry): StreamRow {
  switch (entry.kind) {
    case "text":
      return { role: "assistant", text: entry.content }
    case "thinking":
      return { role: "system", text: entry.content, meta: "thinking" }
    case "tool":
      return { role: "tool", text: entry.arguments, meta: entry.name }
    case "tool_result":
      return {
        role: "tool",
        text: entry.content,
        meta: entry.isError ? `${entry.name}!` : entry.name,
      }
    case "report":
      return { role: "assistant", text: entry.content, meta: "report" }
  }
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
    lines: picked.entries.map(rowFromTranscriptEntry),
  }
}

/** Mount the OpenTUI host for a live session. */
export async function mountRunnerHost(deps: RunnerHostDeps): Promise<RunnerHost> {
  const models = buildModelCatalog(deps.providers)
  const host = await mountProductHost({
    title: deps.title,
    eventEmitter: deps.eventEmitter,
    send: deps.send,
    interrupt: deps.interrupt,
    ...(deps.deliver !== undefined ? { deliver: deps.deliver } : {}),
    ...(models.length > 0 ? { models, onModelSelect: deps.onModelSelect } : {}),
    commands: buildCommandCatalog(deps.commands),
    onCommand: deps.onCommand,
    chrome: chromeFromSession(deps.chrome()),
    onObserveRequest: () => observeSessionFromSubAgents(deps.subAgentSessions()),
    ...(deps.createRenderer !== undefined ? { createRenderer: deps.createRenderer } : {}),
  })

  const pushChrome = (): void => {
    host.setChrome(chromeFromSession(deps.chrome()))
  }
  const unsubscribeChrome = deps.subscribeChrome?.(pushChrome)

  // The shell's Ctrl+C is the interrupt key, so quitting needs its own binding.
  const onKey = (key: KeyEvent): void => {
    if (key.ctrl && key.name === "d") {
      key.preventDefault()
      dispose()
    }
  }
  host.renderer.keyInput.on("keypress", onKey)

  const dispose = (): void => {
    unsubscribeChrome?.()
    host.renderer.keyInput.off("keypress", onKey)
    host.dispose()
  }

  const surfaceDeps: CommandSurfaceDeps = {
    ...(deps.surfaces ?? {}),
    ...(host.openModels !== undefined ? { openModels: host.openModels } : {}),
    notify: (text) =>
      appendStreamRow(host.shell, { role: "system", text, meta: "command" }),
  }

  return {
    ...host,
    dispose,
    openSurface: (kind) => openCommandSurface(host.shell, kind, surfaceDeps),
  }
}
