import { describe, expect, test } from "bun:test"
import {
  DEFAULT_PALETTE_COMMANDS,
  filterPaletteCommands,
  paletteLabels,
} from "./palette"

describe("filterPaletteCommands", () => {
  test("empty query returns full catalog", () => {
    const all = filterPaletteCommands("")
    expect(all.length).toBe(DEFAULT_PALETTE_COMMANDS.length)
    expect(all).toEqual([...DEFAULT_PALETTE_COMMANDS])
  })

  test("matches label substring", () => {
    const hits = filterPaletteCommands("model")
    expect(hits.some((c) => c.id === "model_picker")).toBe(true)
    expect(hits.every((c) => c.label.toLowerCase().includes("model") || (c.keywords ?? []).some((k) => k.includes("model")) || c.id.includes("model"))).toBe(true)
  })

  test("matches keywords", () => {
    const hits = filterPaletteCommands("yank")
    expect(hits.some((c) => c.id === "copy_active")).toBe(true)
  })

  test("no matches empty array", () => {
    expect(filterPaletteCommands("zzzz-nope")).toEqual([])
  })
})

describe("paletteLabels", () => {
  test("stable order labels", () => {
    const labels = paletteLabels(DEFAULT_PALETTE_COMMANDS)
    expect(labels[0]).toBe("Open permissions")
    expect(labels.length).toBe(DEFAULT_PALETTE_COMMANDS.length)
  })
})
