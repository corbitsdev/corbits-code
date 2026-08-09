/**
 * Landing anatomy: the animated mark, a vertically centred prompt box, the
 * telemetry disclosure and selectable starters — and nothing left over once
 * the transcript has content.
 */
import { describe, expect, test } from "bun:test"
import type { CapturedSpan } from "@opentui/core"
import { rgbToHex } from "@opentui/core"
import { withTestRenderer, type Harness } from "./harness"
import {
  appendStreamRow,
  applyLandingSuggestion,
  createAppShell,
  noticeText,
  paintChrome,
  setChromeZones,
  setPromptWorkspace,
  isLanding,
  paintLanding,
  streamRowCount,
  surfaceSystemNotice,
} from "./shell"
import { makeOperatorQuestion, openOperatorOverlay } from "./overlays"
import {
  LANDING_HINTS,
  LANDING_SUGGESTIONS,
  LANDING_VERSION,
  landingBelowContent,
  landingBelowRows,
  landingSuggestionFor,
  resolveMarkGrid,
  splitLandingRows,
  VERSION_BADGE_MIN_COLUMNS,
  VERSION_BADGE_MIN_ROWS,
  versionBadgeVisible,
  wrapLanding,
} from "./landing"
import { LOCKUP_WORDMARK } from "./lockup"
import pkg from "../../package.json" with { type: "json" }
import { MARK_LARGE, MARK_MID, MARK_SMALL } from "./mark-shape"
import { UI } from "./theme"

const SIZE = { width: 80, height: 24 } as const
const NOTICE = "Anonymous usage telemetry is enabled. Disable in /settings."

/** Newly added scroll-box children need a layout pass before they paint. */
async function settle(h: Harness): Promise<void> {
  await h.renderOnce()
  await h.renderOnce()
}

function backgrounds(h: Harness): readonly string[] {
  const frame = h.captureSpans()
  return frame.lines.flatMap((line: { spans: CapturedSpan[] }) =>
    line.spans
      .filter((span) => span.text.trim().length > 0 || span.width > 20)
      .map((span) => rgbToHex(span.bg).toLowerCase().slice(0, 7)),
  )
}

function rows(h: Harness): readonly string[] {
  return h.captureCharFrame().split("\n")
}

/** Landing mark rows only — the bottom-left lockup shares the same glyphs. */
function markRows(h: Harness): readonly string[] {
  return rows(h).filter(
    (row) => /[░▒▓█▁▂▃▄▅▆▇]/.test(row) && !row.includes(LOCKUP_WORDMARK),
  )
}

describe("landing layout math", () => {
  test("splits the transcript zone evenly around the prompt box", () => {
    expect(splitLandingRows(19)).toEqual({ above: 9, below: 10 })
    expect(splitLandingRows(0)).toEqual({ above: 0, below: 0 })
    expect(splitLandingRows(-4)).toEqual({ above: 0, below: 0 })
  })

  test("wraps on words without breaking them", () => {
    expect(wrapLanding("one two three four", 9)).toEqual(["one two", "three", "four"])
    expect(wrapLanding("supercalifragilistic", 4)).toEqual(["supercalifragilistic"])
  })

  test("the disclosure outranks the starters when rows are scarce", () => {
    const full = landingBelowContent({ rows: 10, columns: 78, telemetryNotice: NOTICE })
    expect(full.notice.length).toBeGreaterThan(0)
    expect(full.suggestions).toEqual(LANDING_SUGGESTIONS)

    const cramped = landingBelowContent({
      rows: 3,
      columns: 78,
      telemetryNotice: NOTICE,
    })
    expect(cramped.notice.length).toBeGreaterThan(0)
    expect(cramped.suggestions).toEqual([])
  })

  test("no notice means no notice rows", () => {
    const content = landingBelowContent({ rows: 10, columns: 78 })
    expect(content.notice).toEqual([])
    const text = landingBelowRows(content).map((row) => row.text)
    expect(text).toContain("try")
    expect(text.some((line) => line.includes("telemetry"))).toBe(false)
  })

  test("the mark degrades through its tiers and then disappears", () => {
    // Roomy: the hero grid, which is the only size that reads unambiguously.
    expect(resolveMarkGrid(20, 96)).toBe(MARK_LARGE)
    // A row short of the hero, a tier down rather than a clipped hero.
    expect(resolveMarkGrid(12, 96)).toBe(MARK_MID)
    expect(resolveMarkGrid(9, 96)).toBe(MARK_SMALL)
    // Narrow enough that the mark would crowd the hints: the hints win.
    // (The version moved off this hint block into the shell's own chrome —
    // CL-5736 — so the block is narrower and a bit more room stays for the
    // mark at this width than before.)
    expect(resolveMarkGrid(20, 50)).toBe(MARK_MID)
    expect(resolveMarkGrid(20, 30)).toBeNull()
    expect(resolveMarkGrid(3, 96)).toBeNull()
  })

  test("every starter is reachable by its key", () => {
    for (const item of LANDING_SUGGESTIONS) {
      expect(landingSuggestionFor(item.key)).toBe(item)
    }
    expect(landingSuggestionFor("z")).toBeNull()
  })
})

describe("landing screen", () => {
  test("centres the prompt box between the mark and the disclosure", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        title: "corbits",
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
        telemetryNotice: NOTICE,
      })
      try {
        await settle(h)
        const painted = rows(h)
        // Either corner set: the prompt border's glyphs are the box owner's
        // business, the box's position is what this asserts.
        const top = painted.findIndex((row) => /[┌╭]/.test(row))
        const bottom = painted.findIndex((row) => /[└╰]/.test(row))
        expect(top).toBeGreaterThan(0)
        // The box straddles the terminal's middle row (within the half row an
        // odd-height box on an even-height terminal cannot avoid).
        expect(Math.abs((top + bottom) / 2 - (SIZE.height - 1) / 2)).toBeLessThanOrEqual(1)

        // Mark above, bottom-anchored against the box; disclosure below it.
        const mark = markRows(h)
        // Whichever tier this terminal seats, the mark is whole: a clipped
        // grid would read as a different shape.
        expect([MARK_LARGE, MARK_MID, MARK_SMALL].map((g) => g.rows)).toContain(
          mark.length,
        )
        expect(painted.indexOf(mark.at(-1) as string)).toBeLessThan(top)
        // The two doors sit beside the mark, not under it, and their
        // descriptions share one column — ragged, the pair reads as two
        // unrelated lines rather than as a set.
        const descriptionColumns = new Set<number>()
        for (const hint of LANDING_HINTS) {
          const row = painted.find((line) => line.includes(hint.rest))
          expect(row).toBeDefined()
          expect(row).toContain(hint.key)
          expect(row!.indexOf(hint.key)).toBeGreaterThan(0)
          descriptionColumns.add(row!.indexOf(hint.rest))
        }
        expect(descriptionColumns.size).toBe(1)
        // The version is chrome, not part of the hero: it never shares a row
        // with a hint, and cannot drift from package.json.
        expect(LANDING_VERSION).toBe(`v${pkg.version}`)
        for (const hint of LANDING_HINTS) {
          const row = painted.find((line) => line.includes(hint.rest))
          expect(row).not.toContain(LANDING_VERSION)
        }
        const versionRow = painted.findIndex((row) => row.includes(LANDING_VERSION))
        expect(versionRow).toBeGreaterThanOrEqual(0)
        // Bottom-right: on the terminal's last content row, hugging the right
        // edge rather than sitting under the hints.
        expect(versionRow).toBeGreaterThanOrEqual(SIZE.height - 2)
        const versionCol = painted[versionRow]!.lastIndexOf(LANDING_VERSION)
        expect(versionCol + LANDING_VERSION.length).toBeGreaterThan(SIZE.width - 4)
        const noticeRow = painted.findIndex((row) => row.includes("telemetry"))
        expect(noticeRow).toBeGreaterThan(bottom)
        for (const item of LANDING_SUGGESTIONS) {
          expect(h.captureCharFrame()).toContain(item.label)
        }
      } finally {
        shell.dispose()
      }
    }, SIZE)
  })

  test("the mark paints in the brand orange, not a cool accent", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      })
      try {
        await settle(h)
        const tones = new Set(
          h
            .captureSpans()
            .lines.flatMap((line: { spans: CapturedSpan[] }) => line.spans)
            .filter((span) => /[░▒▓█]/.test(span.text))
            .map((span) => rgbToHex(span.fg).toLowerCase().slice(0, 7)),
        )
        expect(tones.size).toBeGreaterThan(0)
        for (const tone of tones) {
          expect([UI.action, UI.actionDim] as readonly string[]).toContain(tone)
        }
      } finally {
        shell.dispose()
      }
    }, SIZE)
  })

  test("the mark advances off an injected clock while a turn runs", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      })
      try {
        await settle(h)
        const still = markRows(h).join("\n")

        // Idle re-entry holds the filled frame however far the clock moves.
        paintLanding(shell, 1_700, false)
        await settle(h)
        expect(markRows(h).join("\n")).toBe(still)

        const frames = new Set<string>()
        for (const nowMs of [0, 500, 1_100, 1_900, 2_600, 3_400]) {
          paintLanding(shell, nowMs, true)
          await settle(h)
          frames.add(markRows(h).join("\n"))
        }
        expect(frames.size).toBeGreaterThan(1)
      } finally {
        shell.dispose()
      }
    }, SIZE)
  })

  test("a starter key fills the prompt; a typed prompt keeps its digits", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      })
      try {
        await settle(h)
        const first = LANDING_SUGGESTIONS[0]
        expect(first).toBeDefined()
        expect(applyLandingSuggestion(shell, first!.key)).toBe(true)
        expect(shell.prompt.value).toBe(first!.prompt)

        // Already typed: the key is a character, not a shortcut.
        expect(applyLandingSuggestion(shell, first!.key)).toBe(false)
      } finally {
        shell.dispose()
      }
    }, SIZE)
  })

  test("the starters withdraw while the prompt has text", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        telemetryNotice: NOTICE,
      })
      try {
        await settle(h)
        const first = LANDING_SUGGESTIONS[0]!
        expect(h.captureCharFrame()).toContain(first.label)

        shell.prompt.value = "wri"
        paintChrome(shell)
        await settle(h)
        const typing = h.captureCharFrame()
        expect(typing).not.toContain(first.label)
        // The disclosure is not a suggestion and must not withdraw with them.
        expect(typing).toContain("telemetry")

        shell.prompt.value = ""
        paintChrome(shell)
        await settle(h)
        expect(h.captureCharFrame()).toContain(first.label)
      } finally {
        shell.dispose()
      }
    }, SIZE)
  })

  test("the brand lockup sits in the prompt box's bottom border, session-long", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      })
      try {
        await settle(h)
        // The lockup rides the box's bottom rule, so it is on the rule itself
        // rather than on a row of its own beneath it.
        const landingPainted = rows(h)
        const landingRow = landingPainted.findIndex((row) =>
          row.includes(LOCKUP_WORDMARK),
        )
        expect(landingRow).toBeGreaterThanOrEqual(0)
        expect(landingPainted[landingRow]).toContain("╰")

        // It outlives the landing: this is session chrome, not a splash.
        appendStreamRow(shell, { role: "user", text: "first prompt" })
        await settle(h)
        const painted = rows(h)
        const ruleRow = painted.findIndex((row) =>
          row.includes(LOCKUP_WORDMARK),
        )
        // Session-active: the version row only reserves space on the landing
        // screen (see `relayout`), so once there is real transcript content
        // the box is back on the terminal's very last row.
        expect(ruleRow).toBe(SIZE.height - 1)
        const row = painted[ruleRow]!
        // Left end of the rule, inside the shell gutter, costing no row.
        expect(row.startsWith(" ╰─ ")).toBe(true)
        expect(row.trimEnd().endsWith("╯")).toBe(true)
      } finally {
        shell.dispose()
      }
    }, SIZE)
  })

  test("a narrow rule drops the lockup and keeps the workspace", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 34, rows: 20 },
          wireKeys: false,
          cwd: "/src/corbits-code",
        })
        try {
          setPromptWorkspace(shell, { branch: "migration/opentui-tui" })
          await settle(h)
          const frame = h.captureCharFrame()
          // The workspace is information and the mark is not: the mark goes.
          expect(frame).not.toContain(LOCKUP_WORDMARK)
          expect(frame).toContain("(migration/opentui-tui) ─╯")
        } finally {
          shell.dispose()
        }
      },
      { width: 34, height: 20 },
    )
  })

  test("an overlay covers the landing, sliding it only as far as its content needs", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 100, rows: 30 },
          wireKeys: false,
          run: "idle",
          telemetryNotice: NOTICE,
        })
        try {
          await settle(h)
          const before = rows(h)
          const anchors = ["message", "telemetry", LANDING_SUGGESTIONS[0]!.label]
          const was = anchors.map((text) =>
            before.findIndex((row) => row.includes(text)),
          )
          expect(was.every((index) => index > 0)).toBe(true)
          // The anchors are listed top to bottom, so their positions climb
          // together before the overlay opens.
          expect(was).toEqual([...was].sort((a, b) => a - b))

          openOperatorOverlay(shell)
          await settle(h)
          const after = rows(h)
          // Every landing anchor is still on screen and in the same relative
          // order: the overlay is not letting the composition it covers spill
          // off the viewport, overlap itself, or reshuffle. It may still
          // slide the composition (up or down a little, as the mark re-grids
          // for its new tier) when its own content needs more room than the
          // even top/bottom split would otherwise leave it.
          const nowAt = anchors.map((text) =>
            after.findIndex((row) => row.includes(text)),
          )
          expect(nowAt.every((index) => index > 0)).toBe(true)
          expect(nowAt).toEqual([...nowAt].sort((a, b) => a - b))
          expect(new Set(nowAt).size).toBe(nowAt.length)
          expect(h.captureCharFrame()).toContain("operator")
        } finally {
          shell.dispose()
        }
      },
      { width: 100, height: 30 },
    )
  })

  // A question with more choices than the even top/bottom split would leave
  // room for used to get its list starved down to whatever that split
  // happened to allow — as little as one or two choices — because the float
  // only asked the split for one choice row of headroom. It now asks for the
  // overlay's real, already fraction-capped content height, so a terminal
  // tall enough for that content shows every choice without scrolling.
  test("a landing overlay with many choices shows them all when there is room", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 100, rows: 36 },
          wireKeys: false,
          run: "idle",
        })
        try {
          openOperatorOverlay(shell)
          await settle(h)
          const frame = h.captureCharFrame()
          for (const choice of makeOperatorQuestion().choices) {
            expect(frame).toContain(choice)
          }
        } finally {
          shell.dispose()
        }
      },
      { width: 100, height: 36 },
    )
  })

  test("a short or narrow terminal shrinks the mark, never the prompt box", async () => {
    for (const size of [
      { width: 100, height: 30 },
      { width: 80, height: 24 },
      { width: 60, height: 20 },
    ]) {
      await withTestRenderer(async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: size.width, rows: size.height },
          wireKeys: false,
          run: "idle",
          telemetryNotice: NOTICE,
        })
        try {
          await settle(h)
          const painted = rows(h)
          // The prompt field is on screen at every size, and the mark fits
          // above it rather than overrunning it.
          const field = painted.findIndex((row) => row.includes("message"))
          expect(field).toBeGreaterThan(0)
          expect(field).toBeLessThan(size.height)
          expect(markRows(h).length).toBeLessThan(field)
          expect(h.captureCharFrame()).toContain(LANDING_HINTS[0]!.rest)
        } finally {
          shell.dispose()
        }
      }, size)
    }
  })

  test("no titlebar, status strip or counter row survives", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      })
      try {
        await settle(h)
        const frame = h.captureCharFrame()
        for (const gone of ["BUSY", "IDLE", "FOLLOW", "queue", "lines", "focus"]) {
          expect(frame).not.toContain(gone)
        }
        // The old header blue and status green are gone as fills.
        const fills = new Set(backgrounds(h))
        expect(fills.has("#3d59a1")).toBe(false)
        expect(fills.has("#9ece6a")).toBe(false)
      } finally {
        shell.dispose()
      }
    }, SIZE)
  })

  test("the landing is dropped once the transcript has content", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        telemetryNotice: NOTICE,
      })
      try {
        await settle(h)
        expect(isLanding(shell)).toBe(true)
        appendStreamRow(shell, { role: "user", text: "first prompt" })
        await settle(h)
        expect(isLanding(shell)).toBe(false)
        const frame = h.captureCharFrame()
        expect(markRows(h)).toEqual([])
        expect(frame).toContain("first prompt")
        expect(frame).not.toContain("explain this codebase")
        // The disclosure survives the teardown as a transcript row.
        expect(frame).toContain("telemetry")
        // The prompt box is back at the foot of the screen.
        const painted = rows(h)
        expect(painted.findIndex((row) => /[└╰]/.test(row))).toBeGreaterThan(
          SIZE.height - 4,
        )
      } finally {
        shell.dispose()
      }
    }, SIZE)
  })

  test("startup MCP/load errors keep the mountain and ride the notice strip", async () => {
    // CL-5618 / CL-5600: system notices on load used to appendStreamRow →
    // clearLandingMark, wiping the brand hero. They must surface as secondary
    // chrome while geometry still seats MARK_SMALL or larger.
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      })
      try {
        await settle(h)
        expect(isLanding(shell)).toBe(true)
        const before = markRows(h)
        expect([MARK_LARGE, MARK_MID, MARK_SMALL].map((g) => g.rows)).toContain(
          before.length,
        )

        const mcpError =
          "mcp github did not connect (ECONNREFUSED) — its tools are unavailable; /mcp for detail"
        surfaceSystemNotice(shell, mcpError)
        await settle(h)

        // The mountain stays; the notice strip carries the wording.
        expect(isLanding(shell)).toBe(true)
        expect(streamRowCount(shell)).toBe(0)
        expect(shell.statusFlash).toBe(mcpError)
        expect(noticeText(shell)).toContain("mcp github did not connect")
        const after = markRows(h)
        expect(after.length).toBe(before.length)
        expect([MARK_LARGE, MARK_MID, MARK_SMALL].map((g) => g.rows)).toContain(
          after.length,
        )

        // A real session row still ends the landing; deferred notices become
        // durable transcript rows rather than vanishing with the flash.
        appendStreamRow(shell, { role: "user", text: "first prompt" })
        await settle(h)
        expect(isLanding(shell)).toBe(false)
        expect(markRows(h)).toEqual([])
        const frame = h.captureCharFrame()
        expect(frame).toContain("first prompt")
        expect(frame).toContain("mcp github did not connect")
      } finally {
        shell.dispose()
      }
    }, SIZE)
  })

  test("startup plugin diagnostics keep the mountain too", async () => {
    // CL-5718: CL-5618 routed MCP and hook notices away from the transcript
    // but left plugin diagnostics going through the runner's own system-row
    // helper, so any missing skill wiped the whole hero on load. The flush is
    // a named seam now precisely so no producer of a startup diagnostic gets
    // to decide this again.
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      })
      try {
        await settle(h)
        expect(isLanding(shell)).toBe(true)
        const before = markRows(h)
        expect(before.length).toBeGreaterThan(0)

        const summary = "plugins: 3 skills missing: brand-identity, style, philosophy"
        surfaceSystemNotice(shell, summary)
        await settle(h)

        expect(isLanding(shell)).toBe(true)
        expect(markRows(h).length).toBe(before.length)
        expect(streamRowCount(shell)).toBe(0)
        expect(noticeText(shell)).toContain("3 skills missing")
      } finally {
        shell.dispose()
      }
    }, SIZE)
  })

  test("a flushed startup notice never carries a plumbing gutter label", async () => {
    // The transcript must never label a row "command": a system row's text
    // already says what it is, and the meta column is the operator's, not the
    // wiring's.
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      })
      try {
        await settle(h)
        surfaceSystemNotice(shell, "plugins: 1 skill missing: style")
        appendStreamRow(shell, { role: "user", text: "first prompt" })
        await settle(h)

        expect(isLanding(shell)).toBe(false)
        const frame = h.captureCharFrame()
        expect(frame).toContain("1 skill missing")
        expect(frame).not.toContain("command")
        expect(frame).not.toContain("overlay")
      } finally {
        shell.dispose()
      }
    }, SIZE)
  })

  test("the version is chrome, not the hero: it hides before actionable chrome does on a narrow terminal", async () => {
    // Comfortably above the badge's own thresholds but below nothing else —
    // proves the badge is what degrades, and degrades first.
    const roomy = { width: VERSION_BADGE_MIN_COLUMNS + 20, height: VERSION_BADGE_MIN_ROWS + 8 }
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: roomy.width, rows: roomy.height },
          wireKeys: false,
          run: "idle",
        })
        try {
          await settle(h)
          expect(h.captureCharFrame()).toContain(LANDING_VERSION)
        } finally {
          shell.dispose()
        }
      },
      roomy,
    )

    // Just under the badge's column floor: the badge is gone, but the prompt
    // field — genuinely actionable chrome — is still on screen.
    const narrowColumns = {
      width: VERSION_BADGE_MIN_COLUMNS - 1,
      height: VERSION_BADGE_MIN_ROWS + 8,
    }
    expect(versionBadgeVisible(narrowColumns.width, narrowColumns.height)).toBe(false)
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: narrowColumns.width, rows: narrowColumns.height },
          wireKeys: false,
          run: "idle",
        })
        try {
          await settle(h)
          const frame = h.captureCharFrame()
          expect(frame).not.toContain(LANDING_VERSION)
          expect(frame).toContain("message")
        } finally {
          shell.dispose()
        }
      },
      narrowColumns,
    )

    // Just under the badge's row floor: same story, short rather than narrow.
    const shortRows = {
      width: VERSION_BADGE_MIN_COLUMNS + 20,
      height: VERSION_BADGE_MIN_ROWS - 1,
    }
    expect(versionBadgeVisible(shortRows.width, shortRows.height)).toBe(false)
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: shortRows.width, rows: shortRows.height },
          wireKeys: false,
          run: "idle",
        })
        try {
          await settle(h)
          const frame = h.captureCharFrame()
          expect(frame).not.toContain(LANDING_VERSION)
          expect(frame).toContain("message")
        } finally {
          shell.dispose()
        }
      },
      shortRows,
    )
  })

  test("the task panel and the version badge both paint while landing is still mounted, without clipping the prompt", async () => {
    // A resumed session can land with tasks already visible while the
    // landing screen has not been torn down yet (no transcript content sent)
    // — restored chrome and the version badge's reserved row both compete
    // for the same short terminal at once. This is the regression case for
    // that interaction (CL-5735/5736 review, blocker 4).
    const size = { width: 100, height: 17 }
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: size.width, rows: size.height },
          wireKeys: false,
          run: "idle",
        })
        try {
          setChromeZones(shell, {
            task: [{ label: "wire the version badge", status: "doing" }],
          })
          await settle(h)

          expect(isLanding(shell)).toBe(true)
          expect(shell.taskBox.visible).toBe(true)

          const painted = rows(h)
          // captureCharFrame's trailing newline yields one extra split entry.
          expect(painted.length).toBe(size.height + 1)
          // Nothing is clipped off past the terminal's own row count — the
          // frame is exactly as tall as the terminal, not taller.
          expect(painted.slice(size.height).every((row) => row === "")).toBe(
            true,
          )

          const frame = painted.join("\n")
          expect(frame).toContain("wire the version badge")
          expect(frame).toContain(LANDING_VERSION)
          // The prompt field itself is on screen, intact, not pushed off by
          // the combination of the task row and the version row.
          const promptRow = painted.findIndex((row) => row.includes("message"))
          expect(promptRow).toBeGreaterThan(0)
          const box = shell.layout.regions.prompt
          expect(box).toBeDefined()
          expect(box!.y + box!.height).toBeLessThanOrEqual(size.height)
        } finally {
          shell.dispose()
        }
      },
      size,
    )
  })

  test("the version never appears inside the hero block beside the mark/hints", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: SIZE.width, rows: SIZE.height },
          wireKeys: false,
          run: "idle",
        })
        try {
          await settle(h)
          const painted = rows(h)
          const heroEnd = painted.findIndex((row) => /[┌╭]/.test(row))
          expect(heroEnd).toBeGreaterThan(0)
          // Nothing above the box's own top border carries the version — the
          // hero (mark + hint doors) is exactly the two lines, no third.
          for (const row of painted.slice(0, heroEnd)) {
            expect(row).not.toContain(LANDING_VERSION)
          }
        } finally {
          shell.dispose()
        }
      },
      SIZE,
    )
  })
})
