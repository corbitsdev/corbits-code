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
        description: "Show work list",
        keywords: ["tasks", "Show work list", "slash", "command"],
      },
      {
        id: "clear",
        label: "/clear",
        description: "Clear screen",
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
    // A rewrite that mapped hits to `{ id, label, keywords }` would stay green
    // on `.id` alone and blank the overlay description zone after a keystroke.
    expect(filterPaletteCommands("picker", catalog)[0]?.description).toBe(
      "Open model picker",
    )
  })

  test("empty or whitespace description maps into keywords without false matches", () => {
    const sparse = commandItemsFromRegistry([
      { name: "quiet", description: "" },
      { name: "padded", description: "   " },
    ])
    expect(sparse[0]?.keywords).toEqual(["quiet", "", "slash", "command"])
    expect(sparse[1]?.keywords).toEqual(["padded", "   ", "slash", "command"])
    expect(filterPaletteCommands("picker", sparse)).toEqual([])
    expect(filterPaletteCommands("quiet", sparse).map((c) => c.id)).toEqual([
      "quiet",
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
