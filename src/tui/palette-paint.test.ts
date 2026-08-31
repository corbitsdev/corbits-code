/**
 * Frame-level checks for the `/` command list's rows: the label, and how it
 * ellipsizes at narrow widths.
 */
import { describe, expect, test } from "bun:test";

import type { KeyEvent } from "@opentui/core";

import { withTestRenderer } from "./harness";
import type { PaletteCommand } from "./command-catalog";
import {
  acceptOverlaySelection,
  createAppShell,
  handlePaletteFilterKey,
  moveOverlaySelection,
  openPalette,
  type AppShell,
} from "./shell";

const CATALOG: readonly PaletteCommand[] = [
  { id: "help", label: "/help", keywords: ["help", "show keymap help"] },
  { id: "model", label: "/model", keywords: ["model", "switch model / provider"] },
  { id: "mcp", label: "/mcp", keywords: ["mcp", "manage MCP servers"] },
];

async function paletteFrame(width: number): Promise<readonly string[]> {
  return withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: width, rows: 32 },
        wireKeys: false,
        run: "idle",
      });
      openPalette(shell, { catalog: CATALOG });
      await h.renderOnce();
      return h
        .captureCharFrame()
        .split("\n")
        .map((line) => line.replace(/^\s*│/, "").replace(/│\s*$/, "").trimEnd());
    },
    { width, height: 32 },
  );
}

function rowFor(rows: readonly string[], label: string): string | undefined {
  return rows.find((r) => r.includes(label));
}

describe("command list rows", () => {
  test("slash mode omits the orphan filter row and the title rule", async () => {
    const rows = await paletteFrame(100);
    expect(rows.some((r) => r.startsWith("─ command palette ─"))).toBe(false);
    // Default open is typeToFilter:false — query lives in the prompt.
    expect(rows.some((r) => r.trim() === ">")).toBe(false);
  });

  test("typed filter mode keeps the Amp-style filter prompt", async () => {
    const rows = await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 100, rows: 32 },
          wireKeys: false,
          run: "idle",
        });
        openPalette(shell, { catalog: CATALOG, typeToFilter: true });
        await h.renderOnce();
        return h
          .captureCharFrame()
          .split("\n")
          .map((line) => line.replace(/^\s*│/, "").replace(/│\s*$/, "").trimEnd());
      },
      { width: 100, height: 32 },
    );
    expect(rows.some((r) => r.trim() === ">")).toBe(true);
  });

  test("has no leading selection marker or kind column", async () => {
    const rows = await paletteFrame(100);
    const help = rowFor(rows, "/help");
    expect(help).toBeDefined();
    expect(help).not.toContain(">");
    expect(help).not.toContain("view");
  });

  test("ellipsizes a label that cannot fit a narrow width, never dropping it", async () => {
    const rows = await paletteFrame(20);
    const help = rowFor(rows, "help");
    expect(help).toBeDefined();
  });
});

describe("palette filters as you type", () => {
  function withPalette(fn: (shell: AppShell) => void, width = 100): Promise<void> {
    return withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: width, rows: 32 },
          wireKeys: false,
          run: "idle",
        });
        try {
          openPalette(shell, { catalog: CATALOG, typeToFilter: true });
          fn(shell);
        } finally {
          shell.dispose();
        }
      },
      { width, height: 32 },
    );
  }

  function press(shell: AppShell, seq: string): boolean {
    return handlePaletteFilterKey(shell, {
      name: seq,
      sequence: seq,
      ctrl: false,
      meta: false,
      option: false,
    } as unknown as KeyEvent);
  }

  const BACKSPACE = {
    name: "backspace",
    sequence: "",
    ctrl: false,
    meta: false,
    option: false,
  } as unknown as KeyEvent;

  test("printable keys narrow the list and show in the query row", async () => {
    await withPalette((shell) => {
      const all = shell.paletteCommands.length;
      expect(press(shell, "m")).toBe(true);
      press(shell, "o");
      press(shell, "d");
      expect(shell.paletteCommands.length).toBeLessThan(all);
      expect(shell.paletteCommands.some((c) => c.id === "model")).toBe(true);
      expect(shell.overlayBodyLines[0]).toBe("> mod");
    });
  });

  test("backspace widens the list again", async () => {
    await withPalette((shell) => {
      press(shell, "m");
      const narrowed = shell.paletteCommands.length;
      press(shell, "c");
      expect(shell.paletteCommands.length).toBeLessThanOrEqual(narrowed);
      expect(handlePaletteFilterKey(shell, BACKSPACE)).toBe(true);
      expect(handlePaletteFilterKey(shell, BACKSPACE)).toBe(true);
      expect(shell.paletteCommands.length).toBe(CATALOG.length);
      expect(shell.overlayBodyLines[0]).toBe(">");
    });
  });

  test("j and k type into the query instead of navigating", async () => {
    await withPalette((shell) => {
      const before = shell.overlayList?.activeIndex;
      expect(press(shell, "j")).toBe(true);
      expect(shell.overlayList?.activeIndex).toBe(before ?? 0);
      expect(shell.overlayBodyLines[0]).toBe("> j");
    });
  });

  test("arrow and page keys are left to the overlay", async () => {
    await withPalette((shell) => {
      for (const name of ["down", "up", "pagedown", "pageup", "return"]) {
        const key = {
          name,
          sequence: "",
          ctrl: false,
          meta: false,
          option: false,
        } as unknown as KeyEvent;
        expect(handlePaletteFilterKey(shell, key)).toBe(false);
      }
    });
  });

  test("a query matching nothing leaves the list open and empty", async () => {
    await withPalette((shell) => {
      for (const ch of "zzqq") press(shell, ch);
      expect(shell.paletteCommands).toEqual([]);
      expect(shell.overlayItems).toEqual(["(no matches)"]);
      expect(shell.overlayKind).toBe("palette");
    });
  });

  test("type-to-filter no-match Enter leaves the palette open", async () => {
    await withPalette((shell) => {
      for (const ch of "zzqq") press(shell, ch);
      expect(shell.overlayItems).toEqual(["(no matches)"]);
      acceptOverlaySelection(shell);
      expect(shell.overlayKind).toBe("palette");
      expect(shell.overlayList).not.toBeNull();
      expect(shell.overlayItems).toEqual(["(no matches)"]);
    });
  });
});

const DESCRIBED_CATALOG: readonly PaletteCommand[] = [
  {
    id: "help",
    label: "/help",
    description: "Show the keyboard shortcut and command overlay",
  },
  {
    id: "model",
    label: "/model",
    description: "Switch the active model or provider",
  },
  {
    id: "mcp",
    label: "/mcp",
    description: "Manage MCP servers",
  },
];

const HELP_DESC = "Show the keyboard shortcut and command overlay";
const MODEL_DESC = "Switch the active model or provider";

function stripFrameLines(frame: string): string[] {
  return frame.split("\n").map((line) => line.replace(/^\s*│/, "").replace(/│\s*$/, "").trimEnd());
}

/** Interior zone rows under the list rule, before the overlay's bottom border. */
function zoneAfterList(
  lines: readonly string[],
  labels: readonly string[],
): readonly string[] | undefined {
  let last = -1;
  for (const [i, line] of lines.entries()) {
    if (labels.some((label) => line.includes(label))) last = i;
  }
  if (last < 0) return undefined;
  const below = lines.slice(last + 1);
  const ruleAt = below.findIndex((r) => r.includes("─") && !/[┌┐└┘╭╮╰╯]/.test(r));
  if (ruleAt < 0) return undefined;
  const afterRule = below.slice(ruleAt + 1);
  const boxBottom = afterRule.findIndex((r) => /[└┘]/.test(r));
  return boxBottom >= 0 ? afterRule.slice(0, boxBottom) : afterRule;
}

function expectNameOnlyRows(lines: readonly string[], labels: readonly string[]): void {
  for (const label of labels) {
    const row = lines.find((r) => r.includes(label));
    expect(row).toBeDefined();
    expect(row!.trim()).toBe(label);
  }
}

function expectDescriptionUnderListRule(
  lines: readonly string[],
  description: string,
  labels: readonly string[],
): void {
  for (const label of labels) {
    const row = lines.find((r) => r.includes(label));
    expect(row).toBeDefined();
    expect(row).not.toContain(description);
  }
  const zone = zoneAfterList(lines, labels);
  expect(zone).toBeDefined();
  expect(zone!.some((r) => r.includes(description))).toBe(true);
}

describe("command list description zone", () => {
  test("paints the focused command's registry description, not on the row", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 100, rows: 32 },
          wireKeys: false,
          run: "idle",
        });
        openPalette(shell, { catalog: DESCRIBED_CATALOG });
        await h.renderOnce();
        const labels = DESCRIBED_CATALOG.map((c) => c.label);
        const lines = stripFrameLines(h.captureCharFrame());
        expectNameOnlyRows(lines, labels);
        expectDescriptionUnderListRule(lines, HELP_DESC, labels);
      },
      { width: 100, height: 32 },
    );
  });

  test("moving the overlay selection updates the zone to the newly focused command", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 100, rows: 32 },
          wireKeys: false,
          run: "idle",
        });
        openPalette(shell, { catalog: DESCRIBED_CATALOG });
        await h.renderOnce();
        const labels = DESCRIBED_CATALOG.map((c) => c.label);
        const before = stripFrameLines(h.captureCharFrame());
        expectDescriptionUnderListRule(before, HELP_DESC, labels);
        expect(before.join("\n")).not.toContain(MODEL_DESC);

        moveOverlaySelection(shell, 1);
        await h.renderOnce();
        const after = stripFrameLines(h.captureCharFrame());
        expectNameOnlyRows(after, labels);
        expectDescriptionUnderListRule(after, MODEL_DESC, labels);
        expect(after.join("\n")).not.toContain(HELP_DESC);
      },
      { width: 100, height: 32 },
    );
  });

  test("an undescribed row leaves the zone blank without leftover neighbor copy", async () => {
    const mixed: readonly PaletteCommand[] = [
      { id: "help", label: "/help", description: HELP_DESC },
      { id: "model", label: "/model" },
    ];
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 100, rows: 32 },
          wireKeys: false,
          run: "idle",
        });
        openPalette(shell, { catalog: mixed });
        await h.renderOnce();
        const labels = mixed.map((c) => c.label);
        const described = stripFrameLines(h.captureCharFrame());
        expectNameOnlyRows(described, labels);
        expectDescriptionUnderListRule(described, HELP_DESC, labels);
        const reserved = shell.layout.heights.overlay_host;

        moveOverlaySelection(shell, 1);
        await h.renderOnce();
        const blank = stripFrameLines(h.captureCharFrame());
        expectNameOnlyRows(blank, labels);
        const zone = zoneAfterList(blank, labels);
        expect(zone).toBeDefined();
        expect(zone!.every((r) => r.trim() === "")).toBe(true);
        expect(blank.join("\n")).not.toContain(HELP_DESC);
        expect(shell.layout.heights.overlay_host).toBe(reserved);
      },
      { width: 100, height: 32 },
    );
  });
});

describe("command list width", () => {
  // Both boxes are children of the same padded root; a width computed a
  // second way for the floating list drifts from the prompt box's "100%".
  test("shares the prompt box's left/right edges while floating over landing", async () => {
    const rows = await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        openPalette(shell, { catalog: CATALOG });
        await h.renderOnce();
        return h.captureCharFrame().split("\n");
      },
      { width: 80, height: 24 },
    );
    const overlayTop = rows.find((r) => r.includes("┌"));
    const promptTop = rows.find((r) => r.includes("╭"));
    expect(overlayTop).toBeDefined();
    expect(promptTop).toBeDefined();
    expect(overlayTop?.indexOf("┌")).toBe(promptTop?.indexOf("╭"));
    expect(overlayTop?.lastIndexOf("┐")).toBe(promptTop?.lastIndexOf("╮"));
  });
});

describe("command list selection colour", () => {
  test("marks the active row by text colour, not a filled background", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 100, rows: 32 },
          wireKeys: false,
          run: "idle",
        });
        openPalette(shell, { catalog: CATALOG });
        await h.renderOnce();
        const frame = h.captureSpans();
        const activeLine = frame.lines.find((line) =>
          line.spans.some((s) => s.text.includes("/help")),
        );
        const groundLine = frame.lines.find((line) =>
          line.spans.some((s) => s.text.includes("/model")),
        );
        expect(activeLine).toBeDefined();
        expect(groundLine).toBeDefined();
        const activeBg = activeLine!.spans[0]!.bg;
        const groundBg = groundLine!.spans[0]!.bg;
        // Same background either way — selection reads through text colour
        // (fg), not a filled band behind the row.
        expect(activeBg).toEqual(groundBg);
        const activeFg = activeLine!.spans.find((s) => s.text.includes("/help"))!.fg;
        const groundFg = groundLine!.spans.find((s) => s.text.includes("/model"))!.fg;
        expect(activeFg).not.toEqual(groundFg);
      },
      { width: 100, height: 32 },
    );
  });
});

describe("command list height cap", () => {
  const BIG_CATALOG: readonly PaletteCommand[] = Array.from({ length: 50 }, (_, i) => ({
    id: `cmd_${String(i)}`,
    label: `Fake command number ${String(i)} with a longish label`,
  }));

  // Every plugin-inflated catalog and every terminal size gets a bounded
  // frame: the border-to-border row count above the prompt box never grows
  // past the terminal, and the box below stays intact and readable.
  for (const height of [24, 16, 12, 8, 6]) {
    test(`stays within a ${height}-row terminal and keeps the prompt box intact`, async () => {
      await withTestRenderer(
        async (h) => {
          const shell = createAppShell(h.renderer, {
            terminal: { columns: 80, rows: height },
            wireKeys: false,
            run: "idle",
          });
          openPalette(shell, { catalog: BIG_CATALOG, title: "commands · /" });
          await h.renderOnce();
          const lines = h.captureCharFrame().split("\n");
          // captureCharFrame's trailing newline yields one extra split
          // element — the frame itself must not exceed the terminal rows.
          expect(lines.length).toBeLessThanOrEqual(height + 1);
          expect(lines.some((l) => l.includes("message…"))).toBe(true);
        },
        { width: 80, height },
      );
    });
  }

  test("scrolling the selection keeps the active row inside the window", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 12 },
          wireKeys: false,
          run: "idle",
        });
        openPalette(shell, { catalog: BIG_CATALOG, title: "commands · /" });
        await h.renderOnce();
        for (let i = 0; i < 20; i++) moveOverlaySelection(shell, 1);
        await h.renderOnce();
        expect(shell.overlayList?.activeIndex).toBe(20);
        const offset = shell.overlayList?.offset ?? 0;
        const height = shell.overlayList?.height ?? 0;
        expect(offset).toBeLessThanOrEqual(20);
        expect(offset + height).toBeGreaterThan(20);
        const frame = h.captureCharFrame();
        expect(frame).toContain(`Fake command number 20`);
      },
      { width: 80, height: 12 },
    );
  });
});
