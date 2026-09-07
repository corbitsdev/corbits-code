import { describe, expect, test } from "bun:test";

import { focusOwner } from "./focus";
import { withTestRenderer } from "./harness";
import { createAppShell } from "./shell/index";
import type { OverlaySelection } from "./shell/internals";
import {
  acceptOverlaySelection,
  closeInsetOverlay,
  closeReplaceableOverlay,
  openListOverlay,
  setOwnedOverlayItems,
} from "./shell/overlay-host";
import { cycleOverlaySelection, toggleOverlayExpand } from "./shell/overlay-list";
import { openPalette } from "./shell/palette";

const catalog = [{ id: "help", label: "/help", keywords: ["help"] }];

describe("overlay primary bindings across host transitions", () => {
  test("filtered rows retain their ids and values and accept after disposal", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, { run: "idle" });
      const events: string[] = [];
      const selections: OverlaySelection[] = [];
      try {
        openListOverlay(shell, {
          kind: "model_picker",
          items: ["alpha", "beta"],
          itemIds: ["a", "b"],
          itemValues: ["first", "second"],
          typeToFilter: true,
          echoChoice: false,
          onDispose: () => events.push(`dispose:${shell.overlayKind}`),
          onCancel: () => events.push("cancel"),
          onAccept: (selection) => {
            events.push(`accept:${shell.overlayKind}`);
            selections.push(selection);
            openListOverlay(shell, { items: ["next"] });
          },
        });
        h.pressKey("b");
        expect(shell.overlayItems).toEqual(["beta"]);
        expect(shell.overlayBodyLines).toEqual(["> b"]);
        acceptOverlaySelection(shell);
        expect(events).toEqual(["dispose:null", "accept:null"]);
        expect(selections).toEqual([
          { kind: "model_picker", index: 0, label: "beta", id: "b", value: "second" },
        ]);
        expect(shell.overlayItems).toEqual(["next"]);
      } finally {
        shell.dispose();
      }
    });
  });

  test("a bare palette replaces dismissed primary bindings and owns filtering", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, { run: "idle" });
      const events: string[] = [];
      try {
        openListOverlay(shell, {
          items: ["old"],
          onToggleExpand: () => events.push("expand"),
          onCycle: () => events.push("cycle"),
          onCancel: () => events.push("cancel"),
        });
        closeInsetOverlay(shell);
        openPalette(shell, { catalog, typeToFilter: true });
        h.pressKey("h");
        expect(shell.overlayBodyLines).toEqual(["> h"]);
        expect(shell.paletteCommands.map((command) => command.id)).toEqual(["help"]);
        expect(toggleOverlayExpand(shell)).toBe(false);
        expect(cycleOverlaySelection(shell, 1)).toBe(false);
        closeInsetOverlay(shell);
        expect(events).toEqual(["cancel"]);
        expect(focusOwner(shell.focus)).toBe("prompt");
      } finally {
        shell.dispose();
      }
    });
  });

  test("replacing a stacked palette does not clear the captured primary cancellation", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, { run: "idle" });
      const events: string[] = [];
      try {
        openListOverlay(shell, {
          kind: "model_picker",
          items: ["primary"],
          onCancel: () => events.push("cancel"),
        });
        openPalette(shell, { catalog });
        closeReplaceableOverlay(shell);
        expect(shell.overlayKind).toBe("model_picker");
        expect(events).toEqual([]);
        closeInsetOverlay(shell);
        expect(events).toEqual(["cancel"]);
      } finally {
        shell.dispose();
      }
    });
  });

  for (const settlement of ["accept", "cancel", "replace"] as const) {
    test(`stacked palette restores primary bindings before subsequent ${settlement}`, async () => {
      await withTestRenderer(async (h) => {
        const shell = createAppShell(h.renderer, { run: "idle" });
        const events: string[] = [];
        const selections: OverlaySelection[] = [];
        try {
          openListOverlay(shell, {
            kind: "model_picker",
            title: "primary",
            items: ["alpha", "beta"],
            itemIds: ["a", "b"],
            itemValues: ["first", "second"],
            activeIndex: 1,
            echoChoice: false,
            onToggleExpand: () => events.push("expand"),
            onCycle: (id, direction) => events.push(`cycle:${id}:${direction}`),
            onDispose: () => events.push(`dispose:${shell.overlayKind}`),
            onCancel: () => {
              events.push(`cancel:${shell.overlayKind}`);
              openListOverlay(shell, { items: ["from cancel"] });
            },
            onAccept: (selection) => {
              selections.push(selection);
              events.push(`accept:${shell.overlayKind}`);
            },
          });
          openPalette(shell, { catalog, typeToFilter: true });
          h.pressKey("h");
          expect(focusOwner(shell.focus)).toBe("palette");
          expect(events).toEqual([]);
          expect(
            setOwnedOverlayItems(shell, "model_picker", ["alpha", "new beta"], ["a", "b"]),
          ).toBe(true);
          closeInsetOverlay(shell);
          expect(shell.overlayKind).toBe("model_picker");
          expect(shell.overlayItems).toEqual(["alpha", "new beta"]);
          expect(shell.overlayList?.activeIndex).toBe(1);
          expect(focusOwner(shell.focus)).toBe("overlay");
          expect(events).toEqual([]);
          expect(toggleOverlayExpand(shell)).toBe(true);
          expect(cycleOverlaySelection(shell, -1)).toBe(true);
          expect(events).toEqual(["expand", "cycle:b:-1"]);
          events.length = 0;
          if (settlement === "accept") {
            acceptOverlaySelection(shell);
            expect(events).toEqual(["dispose:null", "accept:null"]);
            expect(selections).toEqual([
              { kind: "model_picker", index: 1, label: "new beta", id: "b", value: "second" },
            ]);
          } else if (settlement === "cancel") {
            closeInsetOverlay(shell);
            expect(events).toEqual(["dispose:null", "cancel:null"]);
            expect(shell.overlayItems).toEqual(["from cancel"]);
          } else {
            closeReplaceableOverlay(shell);
            expect(events).toEqual(["dispose:null"]);
          }
        } finally {
          shell.dispose();
        }
      });
    });
  }
});
