import { describe, expect, test } from "bun:test"

import {
  BORDER,
  abbreviateHome,
  composeRule,
  composeWorkspaceLabel,
  isPlainRule,
  ruleText,
  ruleWidth,
} from "./prompt-border"

const TOP = [BORDER.topLeft, BORDER.topRight] as const
const BOTTOM = [BORDER.bottomLeft, BORDER.bottomRight] as const

describe("border characters", () => {
  test("every rounded glyph is one cell wide", () => {
    for (const char of Object.values(BORDER)) {
      expect([...char]).toHaveLength(1)
      expect(char.codePointAt(0)).toBeGreaterThan(0x2500 - 1)
    }
  })
})

describe("composeRule", () => {
  test("a label sits right-aligned with rule either side of it", () => {
    const parts = composeRule({ width: 40, corners: TOP, label: "grok 4.5" })
    expect(ruleText(parts)).toBe("╭─────────────────────────── grok 4.5 ─╮")
    expect(ruleWidth(parts)).toBe(40)
  })

  test("the rule is exactly the requested width", () => {
    for (const width of [80, 60, 48, 40, 20, 3]) {
      const parts = composeRule({ width, corners: TOP, label: "grok 4.5" })
      expect(ruleWidth(parts)).toBe(width)
    }
  })

  test("no label leaves an unbroken run of frame characters", () => {
    const parts = composeRule({ width: 20, corners: TOP })
    expect(isPlainRule(parts)).toBe(true)
    expect(ruleText(parts)).toBe("╭──────────────────╮")
  })

  test("brand and label share a rule wide enough for both", () => {
    const parts = composeRule({
      width: 60,
      corners: BOTTOM,
      brand: "▃▅██▆ corbits code",
      label: "~/x (main)",
    })
    expect(ruleText(parts)).toBe(
      "╰─ ▃▅██▆ corbits code ──────────────────────── ~/x (main) ─╯",
    )
    expect(ruleWidth(parts)).toBe(60)
    expect(parts.some((p) => p.role === "brand")).toBe(true)
    expect(parts.some((p) => p.role === "label")).toBe(true)
  })

  test("a rule too narrow for both keeps the label and drops the brand", () => {
    const parts = composeRule({
      width: 24,
      corners: BOTTOM,
      brand: "▃▅██▆ corbits code",
      label: "~/x (main)",
    })
    expect(parts.some((p) => p.role === "brand")).toBe(false)
    expect(ruleText(parts)).toContain("~/x (main)")
    expect(ruleWidth(parts)).toBe(24)
  })

  test("a rule too narrow for either degrades to a plain rule", () => {
    const parts = composeRule({
      width: 10,
      corners: BOTTOM,
      brand: "▃▅██▆ corbits code",
      label: "~/very/long/path (main)",
    })
    expect(isPlainRule(parts)).toBe(true)
    expect(ruleText(parts)).toBe("╰────────╯")
  })
})

describe("abbreviateHome", () => {
  test("replaces the home prefix and leaves anything else alone", () => {
    expect(abbreviateHome("/home/x/code", "/home/x")).toBe("~/code")
    expect(abbreviateHome("/home/x", "/home/x")).toBe("~")
    expect(abbreviateHome("/srv/code", "/home/x")).toBe("/srv/code")
    expect(abbreviateHome("/home/xyz/code", "/home/x")).toBe("/home/xyz/code")
  })
})

describe("composeWorkspaceLabel", () => {
  const cwd = "/home/x/abklabs/corbits-code"

  test("directory and branch, home abbreviated", () => {
    expect(
      composeWorkspaceLabel({ cwd, branch: "main", home: "/home/x", maxWidth: 80 }),
    ).toBe("~/abklabs/corbits-code (main)")
  })

  test("no branch leaves the directory alone", () => {
    expect(
      composeWorkspaceLabel({ cwd, branch: null, home: "/home/x", maxWidth: 80 }),
    ).toBe("~/abklabs/corbits-code")
  })

  test("the path shortens from the left so the branch always survives", () => {
    const label = composeWorkspaceLabel({
      cwd,
      branch: "migration/opentui-tui",
      home: "/home/x",
      maxWidth: 40,
    })
    expect(label).toEndWith("(migration/opentui-tui)")
    expect(label.startsWith("…")).toBe(true)
    expect(label.length).toBeLessThanOrEqual(40)
  })

  test("a path with no room at all yields to the branch alone", () => {
    expect(
      composeWorkspaceLabel({
        cwd,
        branch: "migration/opentui-tui",
        home: "/home/x",
        maxWidth: 24,
      }),
    ).toBe("(migration/opentui-tui)")
  })

  test("no room for even the branch composes to nothing", () => {
    expect(
      composeWorkspaceLabel({
        cwd,
        branch: "migration/opentui-tui",
        home: "/home/x",
        maxWidth: 8,
      }),
    ).toBe("")
  })

  test("never exceeds the width it was given", () => {
    for (let maxWidth = 0; maxWidth <= 60; maxWidth++) {
      const label = composeWorkspaceLabel({
        cwd,
        branch: "migration/opentui-tui",
        home: "/home/x",
        maxWidth,
      })
      expect(label.length).toBeLessThanOrEqual(maxWidth)
    }
  })
})
