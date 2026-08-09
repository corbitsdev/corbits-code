import { describe, expect, test } from "bun:test"
import {
  commandItemsFromRegistry,
  filterPaletteCommands,
  paletteLabels,
} from "./command-catalog"

describe("commandItemsFromRegistry", () => {
  test("maps listCommands-shaped entries to name-only `/` labels", () => {
    const items = commandItemsFromRegistry([
      { name: "tasks", description: "Show work list" },
      { name: "clear", description: "Clear screen" },
    ])
    expect(items).toEqual([
      {
        id: "tasks",
        label: "/tasks",
        keywords: ["tasks", "Show work list", "slash", "command"],
      },
      {
        id: "clear",
        label: "/clear",
        keywords: ["clear", "Clear screen", "slash", "command"],
      },
    ])
  })
})

describe("filterPaletteCommands", () => {
  const catalog = commandItemsFromRegistry([
    { name: "compact", description: "Compact history" },
    { name: "model", description: "Open model picker" },
  ])

  test("empty query returns the full catalog", () => {
    expect(filterPaletteCommands("", catalog)).toEqual(catalog)
  })

  test("matches by id, label, or description keyword substring", () => {
    expect(filterPaletteCommands("compact", catalog).map((c) => c.id)).toEqual([
      "compact",
    ])
    expect(filterPaletteCommands("picker", catalog).map((c) => c.id)).toEqual([
      "model",
    ])
  })

  test("no match returns an empty list", () => {
    expect(filterPaletteCommands("zzzz", catalog)).toEqual([])
  })
})

describe("paletteLabels", () => {
  test("returns just the display labels", () => {
    const catalog = commandItemsFromRegistry([
      { name: "tasks", description: "Show work list" },
    ])
    expect(paletteLabels(catalog)).toEqual(["/tasks"])
  })
})
