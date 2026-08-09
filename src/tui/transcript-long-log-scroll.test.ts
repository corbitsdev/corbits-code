/**
 * CL-5553: the full retained transcript (bounded by CL-5551's
 * MAX_RETAINED_STREAM_ROWS) has to stay reachable by scrolling, and
 * appending a new row must not rebuild the whole paint tree to do it.
 */
import { describe, expect, test } from "bun:test"
import { withTestRenderer } from "./harness"
import { appendStreamRow, createAppShell, replaceStreamRowAt, streamRowCount } from "./shell"
import { MAX_RETAINED_STREAM_ROWS } from "./long-log"

async function settle(h: { renderOnce: () => Promise<void> }): Promise<void> {
  // Markdown highlighting and viewport culling both settle a frame or two
  // after the triggering mutation, not within it.
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    await h.renderOnce()
  }
}

describe("long-log transcript scrolling", () => {
  test("scrolling to the top reaches the oldest retained row, not just the last 200", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          const total = MAX_RETAINED_STREAM_ROWS + 50
          for (let i = 0; i < total; i++) {
            appendStreamRow(shell, { role: "assistant", text: `row-${i}` })
          }
          await settle(h)

          shell.transcript.scrollTop = 0
          await settle(h)
          const frame = h.captureCharFrame()

          // Rows 0-49 were evicted by the retention cap — gone by design, not
          // a scrolling bug. Row 50 is the oldest still-retained row and sits
          // 450 rows above the old 200-row paint window; it must be reachable
          // in one scroll rather than staying stranded behind a collapsed marker.
          expect(frame).toContain("row-50")
          expect(frame).not.toContain("row-49")
          // The boundary says rows were dropped rather than reading as the
          // true start of history — eviction is permanent, unlike the old
          // collapse marker, so scrolling further will never reveal row 0.
          expect(frame).toContain("50 earlier rows dropped")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("appending past the retention cap evicts at most one painted node, not the whole window", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          for (let i = 0; i < MAX_RETAINED_STREAM_ROWS; i++) {
            appendStreamRow(shell, { role: "assistant", text: `row-${i}` })
          }
          await settle(h)

          let removed = 0
          const originalRemove = shell.transcript.remove.bind(shell.transcript)
          shell.transcript.remove = (child) => {
            removed += 1
            return originalRemove(child)
          }

          // Now at the cap: this append evicts exactly one row from the front.
          appendStreamRow(shell, { role: "assistant", text: "one-more" })
          await settle(h)

          // Before this fix, repaintTranscriptWindow ran on every append once
          // the log passed LONG_LOG_COLLAPSE_THRESHOLD (500): it tore down every
          // existing child and repainted windowSlice's LONG_LOG_WINDOW (200) rows
          // from scratch — 200 removals for this one append, every append after.
          expect(removed).toBe(1)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("the eviction notice updates in place across repeated evictions, not by teardown", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          for (let i = 0; i < MAX_RETAINED_STREAM_ROWS + 3; i++) {
            appendStreamRow(shell, { role: "assistant", text: `row-${i}` })
          }
          await settle(h)
          shell.transcript.scrollTop = 0
          await settle(h)
          expect(h.captureCharFrame()).toContain("3 earlier rows dropped")

          appendStreamRow(shell, { role: "assistant", text: "one-more" })
          await settle(h)
          shell.transcript.scrollTop = 0
          await settle(h)
          expect(h.captureCharFrame()).toContain("4 earlier rows dropped")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("replaceStreamRowAt stays a single-node retext after eviction has started", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          for (let i = 0; i < MAX_RETAINED_STREAM_ROWS + 5; i++) {
            appendStreamRow(shell, { role: "assistant", text: `row-${i}` })
          }
          await settle(h)

          let removed = 0
          const originalRemove = shell.transcript.remove.bind(shell.transcript)
          shell.transcript.remove = (child) => {
            removed += 1
            return originalRemove(child)
          }

          // Streaming token updates hit this path on every delta; past the
          // retention cap it must still touch one node, not the eviction
          // notice's presence forcing a full repaintTranscriptWindow.
          const lastIndex = streamRowCount(shell) - 1
          replaceStreamRowAt(shell, lastIndex, { role: "assistant", text: "edited" })
          await settle(h)

          expect(removed).toBeLessThanOrEqual(1)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})
