/**
 * The shared description-zone kit: `describe` on `openListOverlay` reserves a
 * fixed two-line zone under a rule, and `onCycle` claims Left/Right for
 * overlays that opt in (settings inline cycling).
 */

import { describe, expect, test } from "bun:test";

import { withTestRenderer } from "./harness.js";
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
