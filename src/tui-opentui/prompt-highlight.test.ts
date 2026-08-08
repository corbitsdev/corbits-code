/**
 * End-to-end: a recognized skill/agent name typed into the real prompt
 * widget paints orange; a lookalike that merely contains a recognized name
 * does not.
 */
import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { withTestRenderer, type Harness } from "./harness"
import {
  createAppShell,
  setPromptRecognitionSource,
  syncPromptHighlights,
  type AppShell,
} from "./shell"
import { UI } from "./theme"

const ACTION_FG = RGBA.fromHex(UI.action)

function withShell(
  fn: (shell: AppShell, h: Harness) => Promise<void> | void,
): Promise<void> {
  return withTestRenderer(async (h) => {
    const shell = createAppShell(h.renderer, {
      terminal: { columns: 60, rows: 20 },
      wireKeys: true,
      run: "idle",
    })
    setPromptRecognitionSource(shell, () => ({
      skillNames: ["brand review"],
      agentNames: ["emil", "draper"],
    }))
    try {
      await fn(shell, h)
    } finally {
      shell.dispose()
    }
  })
}

async function compose(shell: AppShell, h: Harness, value: string): Promise<void> {
  shell.prompt.value = value
  syncPromptHighlights(shell)
  await h.renderOnce()
  await h.renderOnce()
}

function spansFor(h: Harness, text: string): { text: string; fg: RGBA }[] {
  const found: { text: string; fg: RGBA }[] = []
  for (const line of h.captureSpans().lines) {
    for (const span of line.spans) {
      if (span.text.includes(text)) found.push({ text: span.text, fg: span.fg })
    }
  }
  return found
}

describe("prompt recognition highlighting", () => {
  test("a recognized agent name paints in the action color", async () => {
    await withShell(async (shell, h) => {
      await compose(shell, h, "ask emil to review")
      const spans = spansFor(h, "emil")
      expect(spans.length).toBeGreaterThan(0)
      expect(spans.some((s) => s.fg.equals(ACTION_FG))).toBe(true)
    })
  })

  test("a recognized multi-word skill name paints in the action color", async () => {
    await withShell(async (shell, h) => {
      await compose(shell, h, "ask draper to run a brand review")
      const spans = spansFor(h, "brand review")
      expect(spans.length).toBeGreaterThan(0)
      expect(spans.some((s) => s.fg.equals(ACTION_FG))).toBe(true)
    })
  })

  test("a lookalike that is not a recognized name stays unstyled", async () => {
    await withShell(async (shell, h) => {
      await compose(shell, h, "emily is not emil")
      const spans = spansFor(h, "emily")
      expect(spans.length).toBeGreaterThan(0)
      expect(spans.every((s) => !s.fg.equals(ACTION_FG))).toBe(true)
    })
  })

  test("a mixed line highlights only the recognized tokens", async () => {
    await withShell(async (shell, h) => {
      await compose(shell, h, "emily asked emil and draper for a brand review")
      expect(spansFor(h, "emily").every((s) => !s.fg.equals(ACTION_FG))).toBe(true)
      expect(spansFor(h, "emil").some((s) => s.fg.equals(ACTION_FG))).toBe(true)
      expect(spansFor(h, "draper").some((s) => s.fg.equals(ACTION_FG))).toBe(true)
      expect(spansFor(h, "brand review").some((s) => s.fg.equals(ACTION_FG))).toBe(true)
    })
  })
})
