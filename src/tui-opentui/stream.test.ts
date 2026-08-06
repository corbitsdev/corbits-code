import { describe, expect, test } from "bun:test"
import {
  PROMPT_HINT,
  paintStreamRow,
  sessionHeaderTitle,
} from "./stream"

describe("stream paint", () => {
  test("roles get distinct labels and colors", () => {
    const u = paintStreamRow({ role: "user", text: "hi" })
    const a = paintStreamRow({ role: "assistant", text: "hello" })
    const t = paintStreamRow({ role: "tool", text: "ran", meta: "bash" })
    const s = paintStreamRow({ role: "system", text: "boot" })

    expect(u.content).toContain("you")
    expect(u.content).toContain("hi")
    expect(a.content).toContain("agent")
    expect(t.content).toContain("tool")
    expect(t.content).toContain("bash")
    expect(s.content).toContain("sys")

    const fgs = new Set([u.fg, a.fg, t.fg, s.fg])
    expect(fgs.size).toBe(4)
  })

  test("prompt hint matches locked bindings", () => {
    expect(PROMPT_HINT).toBe(
      "Enter queue · Alt+Enter steer · / commands · Ctrl+C stop (×2 exit)",
    )
  })

  test("session header tags run state", () => {
    expect(sessionHeaderTitle("corbits", "busy")).toContain("BUSY")
    expect(sessionHeaderTitle("corbits", "idle")).toContain("IDLE")
  })
})
