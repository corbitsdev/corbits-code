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
  test("residual openers carry a category", () => {
    const cols = DEFAULT_PALETTE_COMMANDS.map((c) =>
      paletteRowColumns(c, shortcutForPaletteId),
    )
    expect(cols.every((c) => c.category.length > 0)).toBe(true)
    expect(cols.find((c) => c.label === "Show keymap help")?.category).toBe(
      "view",
    )
  })

  test("registry commands get a category from their name", () => {
    const catalog = buildPaletteCatalog({
      commands: [
        { name: "rename", description: "Name the session" },
        { name: "wobble", description: "A plugin command" },
      ],
    })
    expect(catalog.find((c) => c.id === "rename")?.category).toBe("session")
    expect(catalog.find((c) => c.id === "wobble")?.category).toBe("command")
  })

  test("shortcuts come from the shell keybinding table", () => {
    const help = DEFAULT_PALETTE_COMMANDS.find((c) => c.id === "help")
    expect(paletteRowColumns(help!, shortcutForPaletteId).shortcut).toBe("?")
    const toggle = DEFAULT_PALETTE_COMMANDS.find((c) => c.id === "toggle_goal")
    expect(paletteRowColumns(toggle!, shortcutForPaletteId).shortcut).toBe("")
  })
})

describe("formatPaletteRows", () => {
  const ROWS: readonly PaletteRowColumns[] = [
    { category: "view", label: "Show keymap help", shortcut: "?" },
    { category: "edit", label: "Copy active message / tool", shortcut: "Alt+C" },
    { category: "session", label: "Resume prior session", shortcut: "" },
  ]

  test("renders category, label, and right-aligned shortcut at full width", () => {
    const [help, copy] = formatPaletteRows(ROWS, 55)
    expect(help).toHaveLength(55)
    expect(help?.startsWith("view    ")).toBe(true)
    expect(help).toContain("Show keymap help")
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

  // The palette host spends the box border and the selection marker before the
  // row starts, so a terminal N columns wide hands these rows N - 5.
  const ROW_WIDTH_AT_60 = 55
  const ROW_WIDTH_AT_48 = 43

  test("the shortcut column drops first as width narrows", () => {
    expect(paletteRowLayout(ROWS, ROW_WIDTH_AT_60)).toMatchObject({
      showCategory: true,
      showShortcut: true,
    })
    expect(paletteRowLayout(ROWS, ROW_WIDTH_AT_48)).toMatchObject({
      showCategory: true,
      showShortcut: false,
    })
    const rows = formatPaletteRows(ROWS, ROW_WIDTH_AT_48)
    expect(rows[0]?.includes("?")).toBe(false)
    expect(rows[0]?.startsWith("view")).toBe(true)
  })

  test("the category drops next, and the label always survives", () => {
    const layout = paletteRowLayout(ROWS, 34)
    expect(layout.showCategory).toBe(false)
    expect(layout.showShortcut).toBe(false)
    expect(formatPaletteRows(ROWS, 34)[0]?.trimEnd()).toBe("Show keymap help")
  })
})
