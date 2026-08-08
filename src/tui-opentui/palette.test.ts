import { describe, expect, test } from "bun:test"
import { shortcutForPaletteId } from "./keybindings"
import {
  DEFAULT_PALETTE_COMMANDS,
  buildPaletteCatalog,
  filterPaletteCommands,
  formatPaletteRows,
  paletteDispatchOf,
  paletteLabels,
  paletteRowColumns,
  paletteRowLayout,
  type PaletteRowColumns,
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

describe("palette row columns", () => {
  test("shortcuts come from the shell keybinding table", () => {
    const help = DEFAULT_PALETTE_COMMANDS.find((c) => c.id === "help")
    expect(paletteRowColumns(help!, shortcutForPaletteId).shortcut).toBe("?")
    const toggle = DEFAULT_PALETTE_COMMANDS.find((c) => c.id === "toggle_task")
    expect(paletteRowColumns(toggle!, shortcutForPaletteId).shortcut).toBe("")
  })
})

describe("formatPaletteRows", () => {
  const ROWS: readonly PaletteRowColumns[] = [
    { label: "Show keymap help", shortcut: "?" },
    { label: "Copy active message / tool", shortcut: "Alt+C" },
    { label: "Resume prior session", shortcut: "" },
  ]

  test("renders the label and right-aligned shortcut at full width", () => {
    const [help, copy] = formatPaletteRows(ROWS, 55)
    expect(help).toHaveLength(55)
    expect(help?.startsWith("Show keymap help")).toBe(true)
    expect(help?.trimEnd().endsWith("?")).toBe(true)
    expect(copy?.trimEnd().endsWith("Alt+C")).toBe(true)
  })

  test("every row is exactly the requested width", () => {
    for (const width of [40, 48, 60, 100]) {
      for (const row of formatPaletteRows(ROWS, width)) {
        expect(row).toHaveLength(width)
      }
    }
  })

  test("the shortcut column drops as width narrows, and the label always survives", () => {
    expect(paletteRowLayout(ROWS, 40)).toMatchObject({ showShortcut: true })
    expect(paletteRowLayout(ROWS, 30)).toMatchObject({ showShortcut: false })
    const rows = formatPaletteRows(ROWS, 30)
    expect(rows[0]?.includes("?")).toBe(false)
    expect(rows[0]?.trimEnd()).toBe("Show keymap help")
  })
})
