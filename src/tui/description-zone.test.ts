/**
 * The shared description-zone kit: `describe` on `openListOverlay` reserves a
 * fixed two-line zone under a rule, and `onCycle` claims Left/Right for
 * overlays that opt in (settings inline cycling).
 */

import { describe, expect, test } from "bun:test";

import { withTestRenderer } from "./harness.js";
import { describeZoneLines } from "./overlay-body.js";
import {
  appendStreamRow,
  closeInsetOverlay,
  createAppShell,
  cycleOverlaySelection,
  moveOverlaySelection,
  openListOverlay,
  type AppShell,
  type ItemDescription,
} from "./shell.js";
import { UI } from "./theme.js";

async function withShell(
  fn: (shell: AppShell) => Promise<void> | void,
  size: { readonly width: number; readonly height: number } = { width: 100, height: 24 },
): Promise<void> {
  await withTestRenderer(async (h) => {
    const shell = createAppShell(h.renderer, {
      terminal: { columns: size.width, rows: size.height },
      wireKeys: false,
    });
    appendStreamRow(shell, { role: "assistant", text: "session underway" });
    await fn(shell);
  }, size);
}

describe("description zone", () => {
  test("charges rows only when describe is supplied", async () => {
    // Tall terminal so the geometry resolver's overlay cap never kicks in —
    // this test is about the zone's own row cost, not the resolver's floor.
    await withShell(
      (shell) => {
        openListOverlay(shell, { kind: "demo", items: ["a", "b"] });
        const withoutZone = shell.layout.heights.overlay_host;
        closeInsetOverlay(shell);

        openListOverlay(shell, {
          kind: "demo",
          items: ["a", "b"],
          describe: () => ({ what: "an item" }),
        });
        const withZone = shell.layout.heights.overlay_host;

        expect(withZone).toBe(withoutZone + 3);
      },
      { width: 100, height: 60 },
    );
  });

  test("stays a fixed height as the cursor moves across items with different copy", async () => {
    await withShell((shell) => {
      const descriptions: Record<string, ItemDescription> = {
        short: { what: "short" },
        long: {
          what: "a much longer description that will need to wrap across more than one physical line of terminal width",
          impact: "and an impact line that is also long enough to wrap on its own",
        },
      };
      openListOverlay(shell, {
        kind: "demo",
        items: ["short", "long"],
        itemIds: ["short", "long"],
        describe: (id) => descriptions[id] ?? null,
      });
      const hostHeight = shell.layout.heights.overlay_host;

      moveOverlaySelection(shell, 1);
      expect(shell.layout.heights.overlay_host).toBe(hostHeight);

      moveOverlaySelection(shell, -1);
      expect(shell.layout.heights.overlay_host).toBe(hostHeight);
    });
  });

  test("null description renders a blank zone, not a collapsed one", async () => {
    await withShell((shell) => {
      openListOverlay(shell, { kind: "demo", items: ["a"], describe: () => null });
      const zoned = shell.layout.heights.overlay_host;
      closeInsetOverlay(shell);

      openListOverlay(shell, {
        kind: "demo",
        items: ["a"],
        describe: () => ({ what: "present" }),
      });
      expect(shell.layout.heights.overlay_host).toBe(zoned);
    });
  });
});

describe("describeZoneLines", () => {
  test("fills the two-line budget with what, then impact", () => {
    const { lines, fgs } = describeZoneLines(
      { what: "compaction trims the transcript.", impact: "summarize costs a model call." },
      60,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("compaction trims the transcript.");
    expect(lines[1]).toContain("summarize costs a model call.");
    expect(fgs[0]).toBe(UI.textDim);
    expect(fgs[1]).toBe(UI.textFaint);
  });

  test("consequence tone paints the impact line in UI.warning", () => {
    const { fgs } = describeZoneLines(
      { what: "sub-agent cap.", impact: "raising it spends more tokens.", tone: "consequence" },
      60,
    );
    expect(fgs[1]).toBe(UI.warning);
  });

  test("a what that wraps to both lines drops impact, same as narrow width would", () => {
    const { lines } = describeZoneLines(
      {
        what: "a description long enough that wrapping it at this width already spends both of the zone's two lines",
        impact: "never shown",
      },
      24,
    );
    expect(lines.join(" ")).not.toContain("never shown");
  });

  test("degrades at 48 columns by dropping impact, keeping what", () => {
    const desc: ItemDescription = {
      what: "short",
      impact: "dropped at narrow widths",
    };
    const wide = describeZoneLines(desc, 48);
    expect(wide.lines.some((l) => l.includes("short"))).toBe(true);

    const narrow = describeZoneLines(desc, 20);
    expect(narrow.lines.some((l) => l.includes("short"))).toBe(true);
    expect(narrow.lines.some((l) => l.includes("dropped"))).toBe(false);
  });

  test("drops the whole zone's content below the minimum legible width", () => {
    const { lines } = describeZoneLines({ what: "anything" }, 8);
    expect(lines.every((l) => l.length === 0)).toBe(true);
  });

  test("null description renders two blank lines", () => {
    const { lines } = describeZoneLines(null, 60);
    expect(lines).toEqual(["", ""]);
  });
});

describe("onCycle scoping", () => {
  test("Left/Right cycle only when the open overlay supplied onCycle", async () => {
    await withShell((shell) => {
      const calls: { id: string; dir: -1 | 1 }[] = [];
      openListOverlay(shell, {
        kind: "demo",
        items: ["a", "b"],
        itemIds: ["a", "b"],
        onCycle: (id, dir) => calls.push({ id, dir }),
      });
      expect(cycleOverlaySelection(shell, 1)).toBe(true);
      expect(calls).toEqual([{ id: "a", dir: 1 }]);
    });
  });

  test("arrow (j/k) navigation is unaffected in an overlay without onCycle", async () => {
    await withShell((shell) => {
      openListOverlay(shell, { kind: "demo", items: ["a", "b", "c"] });
      expect(shell.overlayList?.activeIndex).toBe(0);
      moveOverlaySelection(shell, 1);
      expect(shell.overlayList?.activeIndex).toBe(1);
      expect(cycleOverlaySelection(shell, 1)).toBe(false);
      expect(shell.overlayList?.activeIndex).toBe(1);
    });
  });
});
