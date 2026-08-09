/**
 * Breathing room: one optical gutter shared by every surface, a blank row above
 * the first transcript row, and a narrow-terminal floor where the gutter yields
 * to content rather than squeezing it.
 */
import { describe, expect, test } from "bun:test"
import {
  BOTTOM_MARGIN_MIN_ROWS,
  MARGIN_MIN_COLUMNS,
  SIDE_MARGIN,
  resolveBottomMarginRows,
  resolveContentWidth,
  resolveSideMargin,
  resolveTopPadRows,
  resolveGeometry,
} from "./geometry/index.js"
import { withTestRenderer, type Harness } from "./harness"
import { appendStreamRow, createAppShell } from "./shell"

async function settle(h: Harness): Promise<void> {
  await h.renderOnce()
  await h.renderOnce()
}

function frameRows(h: Harness): readonly string[] {
  return h.captureCharFrame().split("\n").filter((row) => row.length > 0)
}

describe("side margin resolution", () => {
  test("one column at every affordable width, and zero below the floor", () => {
    expect(SIDE_MARGIN).toBe(1)
    for (const columns of [MARGIN_MIN_COLUMNS, 60, 80, 120, 200]) {
      expect(resolveSideMargin(columns)).toBe(1)
    }
    expect(resolveSideMargin(MARGIN_MIN_COLUMNS - 1)).toBe(0)
    expect(resolveSideMargin(10)).toBe(0)
    expect(resolveSideMargin(0)).toBe(0)
  })

  test("content never touches the first or last column of the frame", () => {
    // The gutter's whole job. A one-column gutter is the narrowest thing that
    // can do it, so this is what would break if it were ever spent.
    for (const columns of [80, 120, 200]) {
      expect(resolveContentWidth(columns)).toBe(columns - 2)
    }
  })

  test("content width never collapses below one column", () => {
    for (const columns of [1, 8, 39, 40, 60, 80, 200]) {
      const width = resolveContentWidth(columns)
      expect(width).toBeGreaterThanOrEqual(1)
      expect(width).toBe(columns - resolveSideMargin(columns) * 2)
    }
  })

  test("the resolver reports the gutter it laid out against", () => {
    for (const columns of [36, 48, 80, 132]) {
      const layout = resolveGeometry({ terminal: { columns, rows: 24 } })
      expect(layout.sideMargin).toBe(resolveSideMargin(columns))
      expect(layout.contentWidth).toBe(resolveContentWidth(columns))
      expect(layout.regions.prompt?.x).toBe(layout.sideMargin)
      expect(layout.regions.prompt?.width).toBe(layout.contentWidth)
    }
  })

  test("the gutter costs no rows", () => {
    const wide = resolveGeometry({ terminal: { columns: 120, rows: 24 } })
    const narrow = resolveGeometry({ terminal: { columns: 30, rows: 24 } })
    expect(wide.chromeHeight).toBe(narrow.chromeHeight)
    expect(wide.transcriptHeight).toBe(narrow.transcriptHeight)
  })
})

describe("top padding", () => {
  test("is carved out of the transcript, and only when it can be spared", () => {
    expect(resolveTopPadRows(20)).toBe(1)
    expect(resolveTopPadRows(6)).toBe(1)
    expect(resolveTopPadRows(5)).toBe(0)
    expect(resolveTopPadRows(0)).toBe(0)
  })

  test("the top pad still holds its own blank row above a bottom-anchored transcript", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        try {
          appendStreamRow(shell, { role: "user", text: "first prompt" })
          await settle(h)
          const rows = h.captureCharFrame().split("\n")
          // Row 0 is still the top pad's own blank row: a single short row
          // sits at the bottom of the transcript zone, against the prompt
          // box, not immediately after the pad.
          expect(rows[0]?.trim()).toBe("")
          const contentIndex = rows.findIndex((r) => r.includes("first prompt"))
          expect(contentIndex).toBeGreaterThan(1)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})

describe("bottom edge", () => {
  test("the prompt box rests on the terminal's last row", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 30 },
          wireKeys: false,
        })
        try {
          appendStreamRow(shell, { role: "user", text: "check the bottom" })
          await settle(h)
          const rows = frameRows(h)
          // The box is what the operator types into; it belongs where the
          // cursor already is, not floating a row above it.
          expect(rows[rows.length - 1]?.trim()).not.toBe("")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 30 },
    )
  })

  test("zone heights still sum to the terminal height at several heights", () => {
    for (const rows of [12, 18, 23, 24, 30, 60]) {
      const layout = resolveGeometry({ terminal: { columns: 80, rows } })
      const total = Object.values(layout.heights).reduce((a, b) => a + b, 0)
      expect(total).toBe(rows)
    }
  })


  test("collapses to zero on a short terminal so nothing else starves", async () => {
    const rows = BOTTOM_MARGIN_MIN_ROWS - 1
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows },
          wireKeys: false,
          run: "idle",
        })
        try {
          appendStreamRow(shell, { role: "user", text: "short terminal" })
          await settle(h)
          expect(shell.bottomPad.height).toBe(1)
          expect(shell.bottomPad.visible).toBe(false)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: rows },
    )
  })
})

describe("painted gutter", () => {
  for (const columns of [120, 80, 60, 48]) {
    test(`nothing paints inside the gutter at ${columns} columns`, async () => {
      await withTestRenderer(
        async (h) => {
          const shell = createAppShell(h.renderer, {
            terminal: { columns, rows: 24 },
            wireKeys: false,
            run: "idle",
          })
          try {
            appendStreamRow(shell, { role: "user", text: "check the margins" })
            appendStreamRow(shell, {
              role: "assistant",
              text: "# heading\n\nbody text that is long enough to wrap somewhere",
            })
            appendStreamRow(shell, {
              role: "tool",
              text: "42 matches",
              meta: "grep",
            })
            await settle(h)

            const margin = resolveSideMargin(columns)
            expect(margin).toBeGreaterThan(0)
            for (const row of frameRows(h)) {
              expect(row.slice(0, margin)).toBe(" ".repeat(margin))
              expect(row.slice(columns - margin, columns)).toBe(
                " ".repeat(margin),
              )
            }
          } finally {
            shell.dispose()
          }
        },
        { width: columns, height: 24 },
      )
    })
  }

  test("below the floor the gutter yields the columns back to content", async () => {
    const columns = MARGIN_MIN_COLUMNS - 4
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        try {
          appendStreamRow(shell, { role: "user", text: "narrow" })
          await settle(h)
          expect(shell.layout.sideMargin).toBe(0)
          expect(shell.layout.contentWidth).toBe(columns)
          // The prompt box is the widest always-on surface: it must still fit.
          expect(frameRows(h).some((row) => row.includes("╭"))).toBe(true)
        } finally {
          shell.dispose()
        }
      },
      { width: columns, height: 24 },
    )
  })
})
