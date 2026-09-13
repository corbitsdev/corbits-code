/**
 * CL-6720: an overlay with nothing to choose reserves zero list rows and
 * paints an explicit empty state inside the body chrome — including on a
 * short terminal, which must not reserve a phantom choice row.
 */
import { describe, expect, test } from "bun:test";

import { withTestRenderer } from "./harness.js";
import { OVERLAY_EMPTY_STATE, overlayChromeRows } from "./overlay-view.js";
import { appendStreamRow } from "./shell/chrome.js";
import { createAppShell } from "./shell/index.js";
import type { AppShell } from "./shell/internals.js";
import {
  closeInsetOverlay,
  openListOverlay,
  setOverlayBody,
  setOwnedOverlayItems,
} from "./shell/overlay-host.js";
import { createOverlayList } from "./shell/overlay-list.js";

interface Size {
  readonly width: number;
  readonly height: number;
}

async function withShell(
  fn: (shell: AppShell, frame: () => string) => Promise<void> | void,
  size: Size = { width: 100, height: 60 },
): Promise<void> {
  await withTestRenderer(async (h) => {
    const shell = createAppShell(h.renderer, {
      terminal: { columns: size.width, rows: size.height },
      wireKeys: false,
    });
    try {
      appendStreamRow(shell, { role: "assistant", text: "session underway" });
      await fn(shell, () => h.captureCharFrame());
      await h.renderOnce();
    } finally {
      shell.dispose();
    }
  }, size);
}

describe("empty overlay layout", () => {
  test("zero rows reserve zero height", async () => {
    await withShell((shell) => {
      openListOverlay(shell, { kind: "demo", items: [] });
      try {
        expect(shell.overlayList?.height).toBe(0);
        // Zero list rows; the host carries chrome plus the one empty-state row.
        const chrome = overlayChromeRows(
          "demo",
          shell.overlayBodyLines.length + 1,
          false,
          false,
        );
        expect(shell.layout.heights.overlay_host).toBe(chrome);
      } finally {
        closeInsetOverlay(shell);
      }
    });
  });

  test("an explicit empty state paints inside the body chrome", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          appendStreamRow(shell, {
            role: "assistant",
            text: "session underway",
          });
          openListOverlay(shell, { kind: "demo", items: [] });
          await h.renderOnce();
          const frame = h.captureCharFrame();
          expect(frame).toContain(OVERLAY_EMPTY_STATE);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("replacing the body on an empty overlay keeps zero rows", async () => {
    await withShell((shell) => {
      openListOverlay(shell, { kind: "demo", items: [] });
      try {
        setOverlayBody(shell, "context line");
        expect(shell.overlayList?.height).toBe(0);
        const chrome = overlayChromeRows(
          "demo",
          shell.overlayBodyLines.length + 1,
          false,
          false,
        );
        expect(shell.layout.heights.overlay_host).toBe(chrome);
      } finally {
        closeInsetOverlay(shell);
      }
    });
  });

  test("replacing all items with none collapses to zero rows", async () => {
    await withShell((shell) => {
      openListOverlay(shell, { kind: "demo", items: ["a", "b"] });
      try {
        expect(setOwnedOverlayItems(shell, "demo", [], [])).toBe(true);
        expect(shell.overlayList?.height).toBe(0);
      } finally {
        closeInsetOverlay(shell);
      }
    });
  });

  test("a short terminal reserves no phantom choice row for an empty overlay", async () => {
    const size = { width: 80, height: 8 };
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: size.width, rows: size.height },
        wireKeys: false,
      });
      try {
        appendStreamRow(shell, { role: "assistant", text: "session underway" });
        openListOverlay(shell, { kind: "demo", items: [] });
        await h.renderOnce();
        await h.renderOnce();
        expect(shell.overlayList?.height).toBe(0);
        const chrome = overlayChromeRows(
          "demo",
          shell.overlayBodyLines.length + 1,
          false,
          false,
        );
        expect(shell.layout.heights.overlay_host).toBe(chrome);
        const frame = h.captureCharFrame();
        const lines = frame.replace(/\n$/, "").split("\n");
        const top = lines.findIndex((l) => l.trimStart().startsWith("┌"));
        const bottom = lines.findIndex(
          (l, i) => i > top && l.trimStart().startsWith("└"),
        );
        expect(top).toBeGreaterThanOrEqual(0);
        expect(bottom).toBeGreaterThan(top);
        expect(bottom).toBeLessThan(lines.length);
        expect(frame).toContain(OVERLAY_EMPTY_STATE);
      } finally {
        shell.dispose();
      }
    }, size);
  });

  test("a non-empty overlay keeps its rows and paints no empty state", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          appendStreamRow(shell, {
            role: "assistant",
            text: "session underway",
          });
          openListOverlay(shell, { kind: "demo", items: ["alpha", "beta"] });
          await h.renderOnce();
          expect(shell.overlayList?.height).toBe(2);
          const frame = h.captureCharFrame();
          expect(frame).toContain("alpha");
          expect(frame).not.toContain(OVERLAY_EMPTY_STATE);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("an empty list wrapper starts at zero rows and still grows", async () => {
    await withTestRenderer(async (h) => {
      const list = createOverlayList(h.renderer, { count: 0, items: 0 });
      expect(list.height).toBe(0);
      list.setHeight(0);
      expect(list.height).toBe(0);
      list.setHeight(2);
      expect(list.height).toBe(2);
    });
  });
});
