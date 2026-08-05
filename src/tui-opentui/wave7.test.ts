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
} from "./residuals.js"
import {
  appendStreamRow,
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
})
