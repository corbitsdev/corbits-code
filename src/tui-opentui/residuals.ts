/**
 * Wave 7 residual surface fixtures + observe session types (pure).
 * Shell openers inject host catalogs via OpenResidualListOpts; fixtures apply
 * only when the host omits `items`.
 *
 * Hosts can also build rows with {@link residualListFromCatalog} and resolve
 * accept callbacks via {@link residualIdFromSelection}.
 */

import { SHELL_SHORTCUTS } from "./keybindings.js"
import type { StreamRow } from "./stream.js"

/** Host-owned residual row: stable id + display label. */
export type ResidualCatalogEntry = {
  readonly id: string
  readonly label: string
}

export type ResidualListPayload = {
  readonly items: readonly string[]
  readonly itemIds: readonly string[]
}

/** Map host catalog entries → openListOverlay items + itemIds. */
export function residualListFromCatalog(
  entries: readonly ResidualCatalogEntry[],
): ResidualListPayload {
  return {
    items: entries.map((e) => e.label),
    itemIds: entries.map((e) => e.id),
  }
}

/**
 * Resolve the stable id for an accepted residual selection.
 * Prefers `selection.id`; falls back to itemIds[index] when provided.
 */
export function residualIdFromSelection(
  selection: { readonly index: number; readonly id?: string },
  itemIds?: readonly string[],
): string | undefined {
  if (selection.id !== undefined) return selection.id
  if (itemIds === undefined) return undefined
  return itemIds[selection.index]
}

export function makeSettingsItems(): readonly string[] {
  return [
    "Permissions — revoke remembered approvals",
    "Compaction — summarize vs drop",
    "Session mode — auto / ask / plan",
    "Sub-agents — max concurrent",
    "Tools — wait-for-approval budget",
    "Telemetry — usage opt-in",
    "Close settings",
  ]
}

/** Help overlay rows derived from the OpenTUI shell's own keybinding
 * catalog, so they cannot drift from what the shell actually implements. */
export function makeHelpItems(): readonly string[] {
  return [
    ...SHELL_SHORTCUTS.map((s) => `${s.keys} — ${s.description}`),
    "Close help",
  ]
}

export function makePluginsItems(): readonly string[] {
  return [
    "plugin:linear — enabled",
    "plugin:github — needs trust",
    "plugin:exa — enabled",
    "Add plugin from path…",
    "Web override: none",
    "Close plugins",
  ]
}

export function makeResumeItems(): readonly string[] {
  return [
    "Fix permissions overflow · 2h ago · idle",
    "Wave 6 palette work · yesterday · done",
    "Spike OpenTUI sticky scroll · 3d · done",
    "Untitled session · 1w · canceled",
    "Close resume",
  ]
}

export function makeMentionItems(): readonly string[] {
  return [
    "@src/tui-opentui/shell.ts",
    "@src/tui-opentui/residuals.ts",
    "@docs/plans/tui-layout-scroll-platform.md",
    "@AGENTS.md",
    "Close mentions",
  ]
}

export type ObserveSession = {
  readonly sessionId: string
  readonly agentId: string
  readonly description: string
  readonly lines: readonly StreamRow[]
}

/** Fixture child session for tests/demo. */
export function makeObserveFixture(): ObserveSession {
  return {
    sessionId: "child-1",
    agentId: "explore",
    description: "map callers of openListOverlay",
    lines: [
      { role: "system", text: "— child session explore —" },
      { role: "user", text: "find every openListOverlay caller" },
      { role: "assistant", text: "Searching src/tui-opentui…" },
      {
        role: "tool",
        text: "grep openListOverlay → 6 hits",
        meta: "tool.done",
      },
      { role: "assistant", text: "Report ready for parent." },
    ],
  }
}
