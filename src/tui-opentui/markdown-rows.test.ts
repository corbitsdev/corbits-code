/**
 * Transcript markdown rendering — assistant rows must render formatted,
 * not as literal markdown source.
 */

import { describe, expect, test } from "bun:test"
import { withTestRenderer, type Harness } from "./harness"
import { appendStreamRow, createAppShell } from "./shell"
import { isMarkdownRow } from "./stream"

const WIDE = { width: 80, height: 24 } as const

const shellOpts = {
  terminal: { columns: 80, rows: 24 },
  wireKeys: false,
} as const

/** Markdown blocks highlight asynchronously; settle before capturing a frame. */
async function settle(h: Harness): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 250))
  await h.renderOnce()
  await h.renderOnce()
  return h.captureCharFrame()
}

describe("markdown transcript rows", () => {
  test("row roles pick markdown only for assistant text", () => {
    expect(isMarkdownRow({ role: "assistant", text: "# hi" })).toBe(true)
    expect(isMarkdownRow({ role: "tool", text: "# hi" })).toBe(false)
    expect(isMarkdownRow({ role: "user", text: "# hi" })).toBe(false)
    expect(isMarkdownRow({ role: "system", text: "# hi" })).toBe(false)
    expect(isMarkdownRow({ role: "tool", text: "# hi", markdown: true })).toBe(
      true,
    )
  })

  test("heading, bold, list, fence and link render formatted", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts)
      appendStreamRow(shell, {
        role: "assistant",
        text: [
          "## Title",
          "",
          "**bolded** text",
          "",
          "- alpha",
          "- beta",
          "",
          "```ts",
          "const x = 1",
          "```",
          "",
          "[docs](https://example.com/docs)",
        ].join("\n"),
      })

      const frame = await settle(h)
      expect(frame).toContain("Title")
      expect(frame).not.toContain("## Title")
      expect(frame).toContain("bolded")
      expect(frame).not.toContain("**bolded**")
      expect(frame).toContain("alpha")
      expect(frame).toContain("const x = 1")
      expect(frame).not.toContain("```")
      expect(frame).toContain("docs")
      expect(frame).not.toContain("](https://example.com/docs)")
    }, WIDE)
  })

  test("tool and system rows stay literal", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts)
      appendStreamRow(shell, { role: "tool", text: "## not a heading" })
      appendStreamRow(shell, { role: "system", text: "**raw**" })

      const frame = await settle(h)
      expect(frame).toContain("## not a heading")
      expect(frame).toContain("**raw**")
    }, WIDE)
  })

  test("streaming row keeps a partial fence uncorrupted", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts)
      appendStreamRow(shell, {
        role: "assistant",
        streaming: true,
        text: ["## Done", "", "```ts", "const partial = "].join("\n"),
      })

      const frame = await settle(h)
      expect(frame).toContain("Done")
      expect(frame).not.toContain("## Done")
      expect(frame).toContain("const partial =")
    }, WIDE)
  })
})
