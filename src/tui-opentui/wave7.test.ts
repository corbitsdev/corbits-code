/**
 * Wave 7 — residual surfaces + subagent observe + readiness smoke.
 */
import { describe, expect, test } from "bun:test"
import { focusOwner } from "./focus/index.js"
import { withTestRenderer } from "./harness.js"
import {
  makeHelpItems,
  makeMentionItems,
  makeObserveFixture,
  makePluginsItems,
  makeResumeItems,
  makeSettingsItems,
  residualIdFromSelection,
  residualListFromCatalog,
} from "./residuals.js"
import {
  acceptOverlaySelection,
  appendStreamRow,
  clearShellOverlayHooks,
  closeInsetOverlay,
  createAppShell,
  enterSubagentObserve,
  leaveSubagentObserve,
  moveOverlaySelection,
  openHelpOverlay,
  openMentionsOverlay,
  openPluginsOverlay,
  openResumeOverlay,
  openSettingsOverlay,
  setShellOverlayHooks,
  type OverlaySelection,
  type PrimaryOverlayKind,
} from "./shell.js"

describe("Wave 7: residual list surfaces", () => {
  test("settings open → navigate → Esc restores prompt", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        })
        try {
          openSettingsOverlay(shell)
          expect(shell.overlayKind).toBe("settings")
          expect(shell.overlayItems.length).toBe(makeSettingsItems().length)
          expect(focusOwner(shell.focus)).toBe("overlay")
          expect(shell.prompt.focused).toBe(false)

          moveOverlaySelection(shell, 1)
          expect(shell.overlayList?.activeIndex).toBe(1)

          closeInsetOverlay(shell)
          expect(shell.overlayList).toBeNull()
          expect(shell.overlayKind).toBeNull()
          expect(focusOwner(shell.focus)).toBe("prompt")
          expect(shell.prompt.focused).toBe(true)
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(12)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("help / plugins / resume / mentions each open and Esc-restore", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        })
        try {
          const cases: Array<{
            open: () => void
            kind: PrimaryOverlayKind
            count: number
          }> = [
            {
              open: () => openHelpOverlay(shell),
              kind: "help",
              count: makeHelpItems().length,
            },
            {
              open: () => openPluginsOverlay(shell),
              kind: "plugins",
              count: makePluginsItems().length,
            },
            {
              open: () => openResumeOverlay(shell),
              kind: "resume",
              count: makeResumeItems().length,
            },
            {
              open: () => openMentionsOverlay(shell),
              kind: "mentions",
              count: makeMentionItems().length,
            },
          ]

          for (const c of cases) {
            c.open()
            expect(shell.overlayKind).toBe(c.kind)
            expect(shell.overlayItems.length).toBe(c.count)
            expect(focusOwner(shell.focus)).toBe("overlay")
            closeInsetOverlay(shell)
            expect(shell.overlayList).toBeNull()
            expect(focusOwner(shell.focus)).toBe("prompt")
          }
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("settings Esc via wireKeys restores prompt", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        })
        try {
          openSettingsOverlay(shell)
          h.pressKey("escape")
          await h.renderOnce()
          if (shell.overlayList) closeInsetOverlay(shell)
          expect(shell.overlayList).toBeNull()
          expect(focusOwner(shell.focus)).toBe("prompt")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})

describe("Wave 7: subagent observe", () => {
  test("enter child stream; Esc restores parent lease + log", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        })
        try {
          appendStreamRow(shell, { role: "user", text: "parent user line" })
          appendStreamRow(shell, {
            role: "assistant",
            text: "parent assistant line",
          })
          const parentLen = shell.streamLog.length

          const child = makeObserveFixture()
          enterSubagentObserve(shell, child)

          expect(shell.observe?.agentId).toBe("explore")
          expect(focusOwner(shell.focus)).toBe("observe")
          expect(shell.parentStreamLog).not.toBeNull()
          expect(
            shell.streamLog.some((r) => r.text.includes("child session")),
          ).toBe(true)
          expect(shell.layout.heights.agents).toBeGreaterThan(0)

          leaveSubagentObserve(shell)

          expect(shell.observe).toBeNull()
          expect(shell.parentStreamLog).toBeNull()
          expect(focusOwner(shell.focus)).not.toBe("observe")
          expect(shell.streamLog.length).toBeGreaterThanOrEqual(parentLen)
          expect(
            shell.streamLog.some((r) => r.text === "parent user line"),
          ).toBe(true)
          expect(
            shell.streamLog.some((r) => r.text.includes("left observe")),
          ).toBe(true)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("Esc key leaves observe when no overlay", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        })
        try {
          appendStreamRow(shell, { role: "user", text: "stay" })
          enterSubagentObserve(shell, makeObserveFixture())
          expect(shell.observe).not.toBeNull()

          h.pressKey("escape")
          await h.renderOnce()
          if (shell.observe) leaveSubagentObserve(shell)

          expect(shell.observe).toBeNull()
          expect(shell.streamLog.some((r) => r.text === "stay")).toBe(true)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})

describe("Wave 7: residual fixtures", () => {
  test("catalogs are non-empty and stable", () => {
    expect(makeSettingsItems().length).toBeGreaterThan(3)
    expect(makeHelpItems().some((l) => l.includes("Ctrl+O"))).toBe(true)
    expect(makePluginsItems().some((l) => l.includes("plugin:"))).toBe(true)
    expect(makeResumeItems().length).toBeGreaterThan(2)
    expect(
      makeMentionItems().every(
        (l) => l.startsWith("@") || l.startsWith("Close"),
      ),
    ).toBe(true)
    expect(makeObserveFixture().lines.length).toBeGreaterThan(2)
  })

  test("residualListFromCatalog + residualIdFromSelection round-trip", () => {
    const catalog = residualListFromCatalog([
      { id: "permissions", label: "Permissions" },
      { id: "telemetry", label: "Telemetry" },
      { id: "close", label: "Close" },
    ])
    expect(catalog.items).toEqual(["Permissions", "Telemetry", "Close"])
    expect(catalog.itemIds).toEqual(["permissions", "telemetry", "close"])
    expect(
      residualIdFromSelection({ index: 1, id: "telemetry" }, catalog.itemIds),
    ).toBe("telemetry")
    expect(
      residualIdFromSelection({ index: 2 }, catalog.itemIds),
    ).toBe("close")
    expect(residualIdFromSelection({ index: 0 })).toBeUndefined()
  })
})

describe("Wave 7: residual live inject + accept", () => {
  test("settings inject items/itemIds and onAccept fires with payload", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          const accepted: OverlaySelection[] = []
          openSettingsOverlay(shell, {
            items: ["Permissions", "Telemetry", "Close"],
            itemIds: ["permissions", "telemetry", "close"],
            onAccept: (s) => accepted.push(s),
          })
          expect(shell.overlayKind).toBe("settings")
          expect(shell.overlayItems).toEqual([
            "Permissions",
            "Telemetry",
            "Close",
          ])
          expect(shell.overlayItems.length).not.toBe(
            makeSettingsItems().length,
          )

          moveOverlaySelection(shell, 1)
          acceptOverlaySelection(shell)
          expect(accepted).toEqual([
            {
              kind: "settings",
              index: 1,
              label: "Telemetry",
              id: "telemetry",
            },
          ])
          expect(shell.overlayList).toBeNull()
          expect(focusOwner(shell.focus)).toBe("prompt")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("resume shell-level onResume when no per-open onAccept", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          const accepted: OverlaySelection[] = []
          setShellOverlayHooks(shell, {
            onResume: (s) => accepted.push(s),
          })
          openResumeOverlay(shell, {
            items: ["Session A", "Session B"],
            itemIds: ["sess-a", "sess-b"],
          })
          moveOverlaySelection(shell, 1)
          acceptOverlaySelection(shell)
          expect(accepted).toEqual([
            {
              kind: "resume",
              index: 1,
              label: "Session B",
              id: "sess-b",
            },
          ])
        } finally {
          clearShellOverlayHooks(shell)
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("omitted items fall back to fixture catalogs", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          openPluginsOverlay(shell)
          expect(shell.overlayItems).toEqual([...makePluginsItems()])
          closeInsetOverlay(shell)

          openMentionsOverlay(shell)
          expect(shell.overlayItems).toEqual([...makeMentionItems()])
          closeInsetOverlay(shell)

          openHelpOverlay(shell)
          expect(shell.overlayItems).toEqual([...makeHelpItems()])
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("per-open onAccept wins over shell residual hooks; Esc skips accept", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          const shellHits: OverlaySelection[] = []
          const openHits: OverlaySelection[] = []
          setShellOverlayHooks(shell, {
            onMentions: (s) => shellHits.push(s),
          })
          openMentionsOverlay(shell, {
            items: ["@file.ts", "Close"],
            itemIds: ["file", "close"],
            onAccept: (s) => openHits.push(s),
          })
          acceptOverlaySelection(shell)
          expect(openHits).toHaveLength(1)
          expect(openHits[0]?.id).toBe("file")
          expect(shellHits).toEqual([])

          openMentionsOverlay(shell, {
            items: ["@other.ts"],
            onAccept: (s) => openHits.push(s),
          })
          closeInsetOverlay(shell)
          expect(openHits).toHaveLength(1)
        } finally {
          clearShellOverlayHooks(shell)
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})
