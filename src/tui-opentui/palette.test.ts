import { describe, expect, test } from "bun:test"
import {
  DEFAULT_PALETTE_COMMANDS,
  buildPaletteCatalog,
  filterPaletteCommands,
  paletteDispatchOf,
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
    expect(
      hits.every(
        (c) =>
          c.label.toLowerCase().includes("model") ||
          (c.keywords ?? []).some((k) => k.includes("model")) ||
          c.id.includes("model"),
      ),
    ).toBe(true)
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

describe("buildPaletteCatalog", () => {
  test("registry commands append as dispatch command", () => {
    const catalog = buildPaletteCatalog({
      commands: [
        { name: "compact", description: "Compact history" },

        { name: "help", description: "Show help" },
      ],
    })
    const compact = catalog.find((c) => c.id === "compact")
    expect(compact?.dispatch).toBe("command")
    expect(compact?.label).toContain("compact")
  })

  test("preferRegistry drops residual when registry uses same id", () => {
    const catalog = buildPaletteCatalog({
      commands: [{ name: "help", description: "Slash help" }],
      preferRegistry: true,
    })
    const helps = catalog.filter((c) => c.id === "help")
    expect(helps.length).toBe(1)
    expect(paletteDispatchOf(helps[0]!)).toBe("command")
  })

  test("filter works on registry-built catalog", () => {
    const catalog = buildPaletteCatalog({
      commands: [{ name: "plugins", description: "Manage plugins" }],
    })
    const hits = filterPaletteCommands("plug", catalog)
    expect(hits.some((c) => c.id === "plugins")).toBe(true)
  })
})
