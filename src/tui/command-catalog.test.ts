import { describe, expect, test } from "bun:test";
import {
  commandItemsFromRegistry,
  filterPaletteCommands,
  formatPaletteRows,
  paletteLabels,
  slashArgItems,
  stripUneditedSlashHint,
  type PaletteCommand,
} from "./command-catalog";
import { BUNDLED_PLUGIN_MARKER } from "../plugins/origin-marker.js";
import { stringWidth } from "./view/height.js";

describe("commandItemsFromRegistry", () => {
  test("maps listCommands-shaped entries to name-only `/` labels", () => {
    const items = commandItemsFromRegistry([
      { name: "tasks", description: "Show work list" },
      { name: "clear", description: "Clear screen" },
    ]);
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
    ]);
  });
});

describe("filterPaletteCommands", () => {
  const catalog = commandItemsFromRegistry([
    { name: "compact", description: "Compact history" },
    { name: "model", description: "Open model picker" },
  ]);

  test("empty query returns the full catalog", () => {
    expect(filterPaletteCommands("", catalog)).toEqual(catalog);
  });

  test("matches by id, label, or description keyword substring", () => {
    expect(filterPaletteCommands("compact", catalog).map((c) => c.id)).toEqual([
      "compact",
    ]);
    expect(filterPaletteCommands("picker", catalog).map((c) => c.id)).toEqual([
      "model",
    ]);
    // A rewrite that mapped hits to `{ id, label, keywords }` would stay green
    // on `.id` alone and blank the overlay description zone after a keystroke.
    expect(filterPaletteCommands("picker", catalog)[0]?.description).toBe(
      "Open model picker",
    );
  });

  test("empty or whitespace description maps into keywords without false matches", () => {
    const sparse = commandItemsFromRegistry([
      { name: "quiet", description: "" },
      { name: "padded", description: "   " },
    ]);
    expect(sparse[0]?.keywords).toEqual(["quiet", "", "slash", "command"]);
    expect(sparse[1]?.keywords).toEqual(["padded", "   ", "slash", "command"]);
    expect(filterPaletteCommands("picker", sparse)).toEqual([]);
    expect(filterPaletteCommands("quiet", sparse).map((c) => c.id)).toEqual([
      "quiet",
    ]);
  });

  test("no match returns an empty list", () => {
    expect(filterPaletteCommands("zzzz", catalog)).toEqual([]);
  });
});

describe("paletteLabels", () => {
  test("returns just the display labels", () => {
    const catalog = commandItemsFromRegistry([
      { name: "tasks", description: "Show work list" },
    ]);
    expect(paletteLabels(catalog)).toEqual(["/tasks"]);
  });
});

describe("command origin markers", () => {
  test("bundled repo rows carry the bundled marker, other origins their label", () => {
    const items = commandItemsFromRegistry([
      { name: "implement", description: "Bundled command", origin: "repo" },
      { name: "mine", description: "Marketplace command", origin: "user" },
      { name: "proj", description: "Project command", origin: "project" },
      { name: "local", description: "Path command", origin: "path" },
      { name: "help", description: "Built-in" },
    ]);
    expect(paletteLabels(items)).toEqual([
      `/implement ${BUNDLED_PLUGIN_MARKER}`,
      "/mine [user]",
      "/proj [project]",
      "/local [path]",
      "/help",
    ]);
  });

  test("marked rows still filter by command name", () => {
    const catalog = commandItemsFromRegistry([
      { name: "implement", description: "Bundled command", origin: "repo" },
    ]);
    expect(filterPaletteCommands("implem", catalog).map((c) => c.id)).toEqual([
      "implement",
    ]);
  });

  test("a marked row still formats to exactly the target width", () => {
    const catalog = commandItemsFromRegistry([
      { name: "implement", description: "Bundled command", origin: "repo" },
    ]);
    for (const width of [16, 24, 40]) {
      const rows = formatPaletteRows(paletteLabels(catalog), width);
      expect(rows).toHaveLength(1);
      expect(stringWidth(rows[0] ?? "")).toBe(width);
    }
  });
});

describe("slashArgItems", () => {
  const hintCmd: PaletteCommand = {
    id: "release",
    label: "/release",
    argumentHint: "<id>",
  };
  const subCmd: PaletteCommand = {
    id: "scale",
    label: "/scale",
    subcommands: [
      { name: "high", description: "Scale high" },
      { name: "low", description: "Scale low" },
    ],
  };
  const bareCmd: PaletteCommand = { id: "mcp", label: "/mcp" };

  test("hint command offers the hint as a single row on the empty tail", () => {
    const rows = slashArgItems(hintCmd, "");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      parentId: "release",
      argValue: "<id>",
      argKind: "hint",
    });
  });

  test("hint command offers nothing once the tail is being typed over", () => {
    expect(slashArgItems(hintCmd, "abc")).toEqual([]);
  });

  test("arg-less command offers no rows", () => {
    expect(slashArgItems(bareCmd, "")).toEqual([]);
  });

  test("subcommands filter by name prefix", () => {
    expect(slashArgItems(subCmd, "").map((r) => r.argValue)).toEqual([
      "high",
      "low",
    ]);
    expect(slashArgItems(subCmd, "h").map((r) => r.argValue)).toEqual(["high"]);
    expect(slashArgItems(subCmd, "zzz")).toEqual([]);
  });

  test("multi-token tail matches no rows — the popup dismisses instead", () => {
    // The dismiss decision itself lives in openSlashArgRows; the catalog half
    // is that a second token can never prefix-match a single subcommand name
    // or an empty-tail hint.
    expect(slashArgItems(subCmd, "high --force")).toEqual([]);
    expect(slashArgItems(hintCmd, "abc def")).toEqual([]);
  });
});

describe("stripUneditedSlashHint", () => {
  const catalog: readonly PaletteCommand[] = [
    { id: "release", label: "/release", argumentHint: "<id>" },
    {
      id: "scale",
      label: "/scale",
      subcommands: [{ name: "high", description: "Scale high" }],
    },
    { id: "mcp", label: "/mcp" },
  ];

  test("exact untouched hint strips to the bare base, selection or not", () => {
    // Selection state is irrelevant: an arrow key drops the untouched
    // selection without editing, and the shape is still the placeholder.
    expect(stripUneditedSlashHint(catalog, "/release <id>")).toBe("/release ");
  });

  test("edited text past the hint is real content, never stripped", () => {
    expect(stripUneditedSlashHint(catalog, "/release <id> extra")).toBeNull();
    expect(stripUneditedSlashHint(catalog, "/release abc")).toBeNull();
  });

  test("subcommand accepts and bare bases never strip", () => {
    expect(stripUneditedSlashHint(catalog, "/scale high ")).toBeNull();
    expect(stripUneditedSlashHint(catalog, "/release ")).toBeNull();
    expect(stripUneditedSlashHint(catalog, "release <id>")).toBeNull();
  });

  test("unknown commands never strip", () => {
    expect(stripUneditedSlashHint(catalog, "/nope <id>")).toBeNull();
  });
});
