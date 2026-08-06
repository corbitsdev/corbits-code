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
  paintChrome,
  isLanding,
  paintLanding,
} from "./shell"
import {
  LANDING_SUGGESTIONS,
  landingBelowContent,
  landingBelowRows,
  landingSuggestionFor,
  splitLandingRows,
  wrapLanding,
} from "./landing"
import { LOCKUP_WORDMARK } from "./lockup"
import { MARK_ROWS } from "./mark-shape"
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
        const top = painted.findIndex((row) => row.includes("┌"))
        const bottom = painted.findIndex((row) => row.includes("└"))
        expect(top).toBeGreaterThan(0)
        // The box straddles the terminal's middle row (within the half row an
        // odd-height box on an even-height terminal cannot avoid).
        expect(Math.abs((top + bottom) / 2 - (SIZE.height - 1) / 2)).toBeLessThanOrEqual(1)

        // Mark above, bottom-anchored against the box; disclosure below it.
        const mark = markRows(h)
        expect(mark).toHaveLength(MARK_ROWS)
        expect(painted.indexOf(mark[MARK_ROWS - 1] as string)).toBeLessThan(top)
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

  test("the brand lockup sits bottom-left on the hint row, session-long", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      })
      try {
        await settle(h)
        // On the landing the hint row still sits under the prompt box, with the
        // disclosure below it; the lockup travels with the hint row, not the
        // screen edge, so it is directly beneath the box.
        const landingPainted = rows(h)
        const landingRow = landingPainted.findIndex((row) =>
          row.includes(LOCKUP_WORDMARK),
        )
        expect(landingRow).toBe(
          landingPainted.findIndex((row) => row.includes("└")) + 1,
        )

        // It outlives the landing: this is session chrome, not a splash.
        appendStreamRow(shell, { role: "user", text: "first prompt" })
        await settle(h)
        const painted = rows(h)
        const hintRow = painted.findIndex((row) => row.includes(LOCKUP_WORDMARK))
        expect(hintRow).toBe(SIZE.height - 1)
        // Left of the hint keys, inside the shell gutter, and costing no row.
        const row = painted[hintRow]!
        expect(row.indexOf(LOCKUP_WORDMARK)).toBeLessThan(
          row.indexOf("/ commands"),
        )
        expect(row.startsWith("  ")).toBe(true)
      } finally {
        shell.dispose()
      }
    }, SIZE)
  })

  test("a narrow row drops the lockup and keeps the keys", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 34, rows: 20 },
          wireKeys: false,
        })
        try {
          await settle(h)
          const frame = h.captureCharFrame()
          expect(frame).not.toContain(LOCKUP_WORDMARK)
          expect(frame).toContain("/ commands")
        } finally {
          shell.dispose()
        }
      },
      { width: 34, height: 20 },
    )
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
        expect(painted.findIndex((row) => row.includes("└"))).toBeGreaterThan(
          SIZE.height - 4,
        )
      } finally {
        shell.dispose()
      }
    }, SIZE)
  })
})
