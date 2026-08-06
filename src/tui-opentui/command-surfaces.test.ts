/**
 * Slash-command surfaces: settings menu, permissions revoke, plugin toggle.
 */
import { describe, expect, test } from "bun:test"

import {
  grantRowLabel,
  openCommandSurface,
  pluginRowLabel,
  settingsRows,
  type CommandSurfaceDeps,
  type GrantEntry,
  type PluginEntry,
  type SettingsSnapshot,
} from "./command-surfaces"
import { withTestRenderer } from "./harness"
import {
  acceptOverlaySelection,
  createAppShell,
  moveOverlaySelection,
  type AppShell,
} from "./shell"

function baseSnapshot(): SettingsSnapshot {
  return {
    compactionMode: "llm",
    sessionMode: "orchestrator",
    maxConcurrentSubAgents: 3,
    waitForApproval: true,
    telemetryEnabled: false,
  }
}

async function withShell(fn: (shell: AppShell) => Promise<void> | void): Promise<void> {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      })
      try {
        await fn(shell)
      } finally {
        shell.dispose()
      }
    },
    { width: 80, height: 24 },
  )
}

function selectById(shell: AppShell, id: string, ids: readonly string[]): void {
  const index = ids.indexOf(id)
  if (index > 0) moveOverlaySelection(shell, index)
}

describe("surface labels", () => {
  test("grant label carries scope, tool, pattern, provider model", () => {
    const entry: GrantEntry = {
      id: "0",
      scopeLabel: "This project",
      tool: "shell",
      pattern: "git status",
      providerModel: "anthropic/opus",
    }
    expect(grantRowLabel(entry)).toBe("This project · shell git status (anthropic/opus)")
  })

  test("plugin label reports trust before enablement", () => {
    const entry: PluginEntry = { id: "a", name: "linear", enabled: false, needsTrust: true }
    expect(pluginRowLabel(entry)).toBe("linear — needs trust")
    expect(pluginRowLabel({ id: "b", name: "exa", enabled: true })).toBe("exa — enabled")
  })

  test("settings rows show live values", () => {
    const labels = settingsRows(baseSnapshot()).map((r) => r.label)
    expect(labels.some((l) => l.includes("Summarize"))).toBe(true)
    expect(labels.some((l) => l.includes("max 3"))).toBe(true)
    expect(labels.some((l) => l.includes("Telemetry — off"))).toBe(true)
  })
})

describe("settings surface", () => {
  test("telemetry row toggles and re-opens with the new value", async () => {
    await withShell((shell) => {
      let telemetry = false
      const snapshot = (): SettingsSnapshot => ({ ...baseSnapshot(), telemetryEnabled: telemetry })
      const deps: CommandSurfaceDeps = {
        notify: () => {},
        settings: {
          read: snapshot,
          setCompactionMode: () => {},
          setSessionMode: () => {},
          setMaxConcurrentSubAgents: () => {},
          setWaitForApproval: () => {},
          setTelemetryEnabled: (value) => {
            telemetry = value
          },
        },
      }
      expect(openCommandSurface(shell, "settings", deps)).toBe(true)
      const ids = settingsRows(snapshot()).map((r) => r.id)
      selectById(shell, "telemetry", ids)
      acceptOverlaySelection(shell)
      expect(telemetry).toBe(true)
      expect(shell.overlayKind).toBe("settings")
      expect(shell.overlayItems.some((l) => l.includes("Telemetry — on"))).toBe(true)
    })
  })

  test("compaction row opens a chooser that applies and returns to settings", async () => {
    await withShell((shell) => {
      const applied: string[] = []
      const deps: CommandSurfaceDeps = {
        notify: () => {},
        settings: {
          read: baseSnapshot,
          setCompactionMode: (mode) => applied.push(mode),
          setSessionMode: () => {},
          setMaxConcurrentSubAgents: () => {},
          setWaitForApproval: () => {},
          setTelemetryEnabled: () => {},
        },
      }
      openCommandSurface(shell, "settings", deps)
      selectById(
        shell,
        "compaction",
        settingsRows(baseSnapshot()).map((r) => r.id),
      )
      acceptOverlaySelection(shell)
      expect(shell.overlayItems[0]).toContain("Summarize")

      moveOverlaySelection(shell, 1)
      acceptOverlaySelection(shell)
      expect(applied).toEqual(["pruning"])
      expect(shell.overlayItems.some((l) => l.startsWith("Compaction"))).toBe(true)
    })
  })

  test("sub-agent chooser applies a numeric limit", async () => {
    await withShell((shell) => {
      const applied: number[] = []
      const deps: CommandSurfaceDeps = {
        notify: () => {},
        settings: {
          read: baseSnapshot,
          setCompactionMode: () => {},
          setSessionMode: () => {},
          setMaxConcurrentSubAgents: (limit) => applied.push(limit),
          setWaitForApproval: () => {},
          setTelemetryEnabled: () => {},
        },
      }
      openCommandSurface(shell, "settings", deps)
      selectById(
        shell,
        "subagents",
        settingsRows(baseSnapshot()).map((r) => r.id),
      )
      acceptOverlaySelection(shell)
      moveOverlaySelection(shell, 1)
      acceptOverlaySelection(shell)
      expect(applied).toEqual([2])
    })
  })
})

describe("permissions surface", () => {
  test("lists live grants and revokes the accepted row", async () => {
    await withShell(async (shell) => {
      let grants: GrantEntry[] = [
        { id: "0", scopeLabel: "Global", tool: "shell", pattern: "ls" },
        { id: "1", scopeLabel: "This project", tool: "read", pattern: "src/**" },
      ]
      const revoked: string[] = []
      const deps: CommandSurfaceDeps = {
        notify: () => {},
        permissions: {
          list: () => Promise.resolve(grants),
          revoke: (id) => {
            revoked.push(id)
            grants = grants.filter((g) => g.id !== id)
            return Promise.resolve()
          },
        },
      }
      openCommandSurface(shell, "permissions", deps)
      await Promise.resolve()
      expect(shell.overlayItems[0]).toBe("Global · shell ls")

      acceptOverlaySelection(shell)
      await Promise.resolve()
      await Promise.resolve()
      expect(revoked).toEqual(["0"])
      expect(shell.overlayItems[0]).toBe("This project · read src/**")
    })
  })

  test("empty grant list still opens with a hint row", async () => {
    await withShell(async (shell) => {
      const deps: CommandSurfaceDeps = {
        notify: () => {},
        permissions: { list: () => Promise.resolve([]), revoke: () => Promise.resolve() },
      }
      openCommandSurface(shell, "permissions", deps)
      await Promise.resolve()
      expect(shell.overlayItems[0]).toContain("No remembered approvals")
    })
  })

  test("no permissions dep notifies instead of opening", async () => {
    await withShell((shell) => {
      const notes: string[] = []
      openCommandSurface(shell, "permissions", { notify: (t) => notes.push(t) })
      expect(shell.overlayList).toBeNull()
      expect(notes).toHaveLength(1)
    })
  })
})

describe("plugins surface", () => {
  test("toggles enablement and re-opens with the new state", async () => {
    await withShell(async (shell) => {
      const state = new Map<string, boolean>([
        ["linear", false],
        ["exa", true],
      ])
      const deps: CommandSurfaceDeps = {
        notify: () => {},
        plugins: {
          list: () =>
            [...state].map(([id, enabled]) => ({ id, name: id, enabled })),
          setEnabled: (id, enabled) => {
            state.set(id, enabled)
          },
        },
      }
      openCommandSurface(shell, "plugins", deps)
      expect(shell.overlayItems[0]).toBe("linear — disabled")

      acceptOverlaySelection(shell)
      await Promise.resolve()
      await Promise.resolve()
      expect(state.get("linear")).toBe(true)
      expect(shell.overlayItems[0]).toBe("linear — enabled")
    })
  })
})

describe("model surface", () => {
  test("routes to the host picker, and reports the gap when absent", async () => {
    await withShell((shell) => {
      let opened = 0
      expect(
        openCommandSurface(shell, "models", { notify: () => {}, openModels: () => opened++ }),
      ).toBe(true)
      expect(opened).toBe(1)
      expect(openCommandSurface(shell, "models", { notify: () => {} })).toBe(false)
    })
  })
})

describe("help surface", () => {
  test("opens the keymap overlay", async () => {
    await withShell((shell) => {
      expect(openCommandSurface(shell, "help", { notify: () => {} })).toBe(true)
      expect(shell.overlayKind).toBe("help")
    })
  })
})
