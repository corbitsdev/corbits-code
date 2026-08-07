import { describe, expect, test } from "bun:test"
import {
  buildCommandCatalog,
  commandItemsFromRegistry,
} from "./command-catalog"
import { DEFAULT_PALETTE_COMMANDS, paletteDispatchOf } from "./palette"

describe("buildCommandCatalog", () => {
  test("maps listCommands-shaped entries to dispatch command names", () => {
    const catalog = buildCommandCatalog([
      { name: "compact", description: "Compact history" },
      { name: "model", description: "Open model picker" },
    ])

    const compact = catalog.find((c) => c.id === "compact")
    expect(compact).toBeDefined()
    expect(compact!.dispatch).toBe("command")
    expect(compact!.label).toContain("/compact")
    expect(compact!.label).toContain("Compact history")
    expect(paletteDispatchOf(compact!)).toBe("command")

    const model = catalog.find((c) => c.id === "model")
    expect(model?.dispatch).toBe("command")
  })

  test("includes residual openers alongside registry commands", () => {
    const catalog = buildCommandCatalog([
      { name: "compact", description: "Compact history" },
    ])
    expect(catalog.some((c) => c.id === "permissions")).toBe(true)
    expect(catalog.some((c) => c.id === "compact")).toBe(true)
    expect(catalog.length).toBeGreaterThan(DEFAULT_PALETTE_COMMANDS.length)
  })

  test("preferRegistry drops residual when registry reuses id", () => {
    const catalog = buildCommandCatalog([
      { name: "help", description: "Slash help" },
    ])
    const helps = catalog.filter((c) => c.id === "help")
    expect(helps.length).toBe(1)
    expect(helps[0]!.dispatch).toBe("command")
  })

  test("empty registry still yields residual catalog", () => {
    const catalog = buildCommandCatalog([])
    expect(catalog.length).toBe(DEFAULT_PALETTE_COMMANDS.length)
    expect(catalog.every((c) => c.dispatch === "residual")).toBe(true)
  })
})

describe("commandItemsFromRegistry", () => {
  test("registry-only items all dispatch as command", () => {
    const items = commandItemsFromRegistry([
      { name: "tasks", description: "Show work list" },
      { name: "clear", description: "Clear screen" },
    ])
    expect(items).toEqual([
      {
        id: "tasks",
        label: "/tasks — Show work list",
        keywords: ["tasks", "slash", "command"],
        dispatch: "command",
        category: "command",
      },
      {
        id: "clear",
        label: "/clear — Clear screen",
        keywords: ["clear", "slash", "command"],
        dispatch: "command",
        category: "session",
      },
    ])
  })
})
