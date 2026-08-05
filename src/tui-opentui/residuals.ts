/**
 * Wave 7 residual surface fixtures + observe session types (pure).
 * Shell/overlays open the panes; this module owns catalogs only.
 */

import type { StreamRow } from "./stream.js"

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

export function makeHelpItems(): readonly string[] {
  return [
    "Enter — queue mid-run (badge)",
    "Alt+Enter — steer at tool boundary",
    "Ctrl+C — interrupt run",
    "Ctrl+O — command palette",
    "Alt+C — copy active message / tool",
    "Esc — close overlay / leave observe",
    "Tab — toggle prompt ↔ transcript focus",
    "/help /model /permissions — slash twins",
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
