import { describe, expect, test } from "bun:test"
import { paintStreamRow } from "./stream"
import { UI } from "./theme"

describe("stream paint", () => {
  test("roles are distinguished by label, and tinted only where earned", () => {
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

    // Both human voices are elements, so both are cream; the gutter label is
    // what separates them. Tool output and system chrome step away from it.
    expect(u.fg).toBe(UI.text)
    expect(a.fg).toBe(UI.text)
    expect(t.fg).toBe(UI.inFlight)
    expect(s.fg).toBe(UI.textDim)
  })

  test("no role paints a gray", () => {
    for (const role of ["user", "assistant", "tool", "system"] as const) {
      const { fg } = paintStreamRow({ role, text: "x" })
      const [r, g, b] = [1, 3, 5].map((i) =>
        Number.parseInt(fg.slice(i, i + 2), 16),
      ) as [number, number, number]
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(8)
    }
  })
})
