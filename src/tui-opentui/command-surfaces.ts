/**
 * Slash-command surfaces for the OpenTUI host.
 *
 * Commands whose result asks for a surface (settings, permissions, plugins,
 * help, model picker) are routed here and opened on the shared overlay host
 * with host-supplied data. Nothing in this module reaches into session state —
 * every read and write arrives through {@link CommandSurfaceDeps}, so the
 * surfaces stay testable without a live runner.
 */

import type { SessionMode } from "../config/session-mode.js"
import { SESSION_MODES } from "../config/session-mode.js"
import { residualIdFromSelection, type ResidualCatalogEntry } from "./residuals.js"
import {
  closeInsetOverlay,
  openHelpOverlay,
  openListOverlay,
  openPluginsOverlay,
  openSettingsOverlay,
  type AppShell,
  type OverlaySelection,
} from "./shell.js"

/** A remembered approval, flattened for display and revocation by id. */
export type GrantEntry = {
  readonly id: string
  readonly scopeLabel: string
  readonly tool: string
  readonly pattern: string
  readonly providerModel?: string
}

/** A discovered plugin with its live enablement state. */
export type PluginEntry = {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly needsTrust?: boolean
}

export type CompactionMode = "llm" | "pruning"

/** Live values behind the settings surface, re-read on every open. */
export type SettingsSnapshot = {
  readonly compactionMode: CompactionMode
  readonly sessionMode: SessionMode
  readonly maxConcurrentSubAgents: number
  readonly waitForApproval: boolean
  readonly telemetryEnabled: boolean
}

export type PermissionsSurfaceDeps = {
  readonly list: () => Promise<readonly GrantEntry[]>
  readonly revoke: (id: string) => Promise<void>
}

export type PluginsSurfaceDeps = {
  readonly list: () => readonly PluginEntry[]
  readonly setEnabled: (id: string, enabled: boolean) => Promise<void> | void
}

export type SettingsSurfaceDeps = {
  readonly read: () => SettingsSnapshot
  readonly setCompactionMode: (mode: CompactionMode) => void
  readonly setSessionMode: (mode: SessionMode) => void
  readonly setMaxConcurrentSubAgents: (limit: number) => void
  readonly setWaitForApproval: (value: boolean) => void
  readonly setTelemetryEnabled: (value: boolean) => void
}

export type CommandSurfaceDeps = {
  readonly permissions?: PermissionsSurfaceDeps
  readonly plugins?: PluginsSurfaceDeps
  readonly settings?: SettingsSurfaceDeps
  /** Opens the host's model/provider picker (owned by the product host). */
  readonly openModels?: () => void
  /** Fallback channel for surfaces with no live data source. */
  readonly notify: (text: string) => void
}

/** Surface a command result can ask for. */
export type CommandSurfaceKind =
  | "help"
  | "settings"
  | "permissions"
  | "plugins"
  | "models"

const CLOSE_ID = "__close__"
const BACK_ID = "__back__"

/** Sub-agent concurrency choices offered by the settings surface. */
export const SUBAGENT_LIMIT_CHOICES: readonly number[] = [1, 2, 3, 4, 6, 8]

export function grantRowLabel(entry: GrantEntry): string {
  const suffix = entry.providerModel !== undefined ? ` (${entry.providerModel})` : ""
  return `${entry.scopeLabel} · ${entry.tool} ${entry.pattern}${suffix}`
}

export function pluginRowLabel(entry: PluginEntry): string {
  const state = entry.needsTrust === true ? "needs trust" : entry.enabled ? "enabled" : "disabled"
  return `${entry.name} — ${state}`
}

/** Top-level settings rows, showing each setting's live value. */
export function settingsRows(snapshot: SettingsSnapshot): readonly ResidualCatalogEntry[] {
  return [
    { id: "permissions", label: "Permissions — revoke remembered approvals" },
    {
      id: "compaction",
      label: `Compaction — ${snapshot.compactionMode === "llm" ? "Summarize" : "Drop"}`,
    },
    { id: "session-mode", label: `Session mode — ${snapshot.sessionMode}` },
    { id: "subagents", label: `Sub-agents — max ${snapshot.maxConcurrentSubAgents}` },
    {
      id: "wait-for-approval",
      label: `Tools — wait-for-approval budget ${snapshot.waitForApproval ? "on" : "off"}`,
    },
    { id: "telemetry", label: `Telemetry — ${snapshot.telemetryEnabled ? "on" : "off"}` },
    { id: CLOSE_ID, label: "Close settings" },
  ]
}

function payload(entries: readonly ResidualCatalogEntry[]): {
  items: readonly string[]
  itemIds: readonly string[]
} {
  return { items: entries.map((e) => e.label), itemIds: entries.map((e) => e.id) }
}

function selectedId(
  selection: OverlaySelection,
  entries: readonly ResidualCatalogEntry[],
): string | undefined {
  return residualIdFromSelection(
    selection,
    entries.map((e) => e.id),
  )
}

/** Open a one-of-N chooser and re-enter the settings menu on any exit. */
function openChoice(
  shell: AppShell,
  deps: CommandSurfaceDeps,
  title: string,
  entries: readonly ResidualCatalogEntry[],
  apply: (id: string) => void,
): void {
  const rows = [...entries, { id: BACK_ID, label: "Back" }]
  openListOverlay(shell, {
    kind: "settings",
    title,
    frameId: "overlay-settings",
    ...payload(rows),
    onAccept: (selection) => {
      const id = selectedId(selection, rows)
      if (id !== undefined && id !== BACK_ID) apply(id)
      openSettingsSurface(shell, deps)
    },
  })
}

/** Settings menu, re-opened after every change so values stay current. */
export function openSettingsSurface(shell: AppShell, deps: CommandSurfaceDeps): void {
  const settings = deps.settings
  if (settings === undefined) {
    openSettingsOverlay(shell)
    return
  }
  closeInsetOverlay(shell)
  const snapshot = settings.read()
  const rows = settingsRows(snapshot)
  openSettingsOverlay(shell, {
    ...payload(rows),
    onAccept: (selection) => {
      const id = selectedId(selection, rows)
      switch (id) {
        case "permissions":
          openPermissionsSurface(shell, deps)
          return
        case "compaction":
          openChoice(
            shell,
            deps,
            "compaction",
            [
              { id: "llm", label: "Summarize — LLM handoff at the context threshold" },
              { id: "pruning", label: "Drop — delete older turns, no inference call" },
            ],
            (choice) => settings.setCompactionMode(choice === "pruning" ? "pruning" : "llm"),
          )
          return
        case "session-mode":
          openChoice(
            shell,
            deps,
            "session mode",
            SESSION_MODES.map((mode) => ({ id: mode, label: mode })),
            (choice) => {
              if (choice === "single" || choice === "orchestrator") {
                settings.setSessionMode(choice)
              }
            },
          )
          return
        case "subagents":
          openChoice(
            shell,
            deps,
            "sub-agents",
            SUBAGENT_LIMIT_CHOICES.map((n) => ({ id: String(n), label: `max ${n}` })),
            (choice) => {
              const limit = Number(choice)
              if (Number.isFinite(limit)) settings.setMaxConcurrentSubAgents(limit)
            },
          )
          return
        case "wait-for-approval":
          settings.setWaitForApproval(!snapshot.waitForApproval)
          openSettingsSurface(shell, deps)
          return
        case "telemetry":
          settings.setTelemetryEnabled(!snapshot.telemetryEnabled)
          openSettingsSurface(shell, deps)
          return
        default:
          return
      }
    },
  })
}

/** Remembered approvals; Enter revokes the highlighted grant. */
export function openPermissionsSurface(shell: AppShell, deps: CommandSurfaceDeps): void {
  const permissions = deps.permissions
  if (permissions === undefined) {
    deps.notify("Permission administration is not available in this session.")
    return
  }
  void permissions.list().then(
    (entries) => {
      closeInsetOverlay(shell)
      const rows: ResidualCatalogEntry[] = entries.map((e) => ({
        id: e.id,
        label: grantRowLabel(e),
      }))
      if (rows.length === 0) {
        rows.push({
          id: CLOSE_ID,
          label: "No remembered approvals — grants you accept appear here",
        })
      }
      rows.push({ id: BACK_ID, label: "Back to settings" })
      openListOverlay(shell, {
        kind: "permissions",
        title: "permissions · Enter revokes",
        frameId: "overlay-permissions",
        ...payload(rows),
        onAccept: (selection) => {
          const id = selectedId(selection, rows)
          if (id === undefined || id === CLOSE_ID) return
          if (id === BACK_ID) {
            openSettingsSurface(shell, deps)
            return
          }
          void permissions.revoke(id).then(
            () => openPermissionsSurface(shell, deps),
            (err: unknown) => deps.notify(`Revoke failed: ${errorText(err)}`),
          )
        },
      })
    },
    (err: unknown) => deps.notify(`Could not read remembered approvals: ${errorText(err)}`),
  )
}

/** Discovered plugins; Enter toggles enablement (and records trust upstream). */
export function openPluginsSurface(shell: AppShell, deps: CommandSurfaceDeps): void {
  const plugins = deps.plugins
  if (plugins === undefined) {
    openPluginsOverlay(shell)
    return
  }
  closeInsetOverlay(shell)
  const entries = plugins.list()
  const rows: ResidualCatalogEntry[] = entries.map((e) => ({
    id: e.id,
    label: pluginRowLabel(e),
  }))
  if (rows.length === 0) {
    rows.push({ id: CLOSE_ID, label: "No plugins discovered" })
  }
  rows.push({ id: CLOSE_ID, label: "Close plugins" })
  openPluginsOverlay(shell, {
    ...payload(rows),
    onAccept: (selection) => {
      const id = selectedId(selection, rows)
      if (id === undefined || id === CLOSE_ID) return
      const target = entries.find((e) => e.id === id)
      if (target === undefined) return
      void Promise.resolve(plugins.setEnabled(target.id, !target.enabled)).then(
        () => openPluginsSurface(shell, deps),
        (err: unknown) => deps.notify(`Plugin update failed: ${errorText(err)}`),
      )
    },
  })
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Open the surface a command asked for.
 * Returns false when no surface exists for the kind, so the caller can report
 * the gap rather than silently swallowing the command.
 */
export function openCommandSurface(
  shell: AppShell,
  kind: CommandSurfaceKind,
  deps: CommandSurfaceDeps,
): boolean {
  switch (kind) {
    case "help":
      openHelpOverlay(shell)
      return true
    case "settings":
      openSettingsSurface(shell, deps)
      return true
    case "permissions":
      openPermissionsSurface(shell, deps)
      return true
    case "plugins":
      openPluginsSurface(shell, deps)
      return true
    case "models":
      if (deps.openModels === undefined) return false
      deps.openModels()
      return true
  }
}
