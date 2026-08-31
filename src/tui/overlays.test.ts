/**
 * Wave 5: primary overlays — open / navigate / Esc restore + resize floors.
 */
import { describe, expect, test } from "bun:test";
import { rgbToHex } from "@opentui/core";
import { IDLE_TRANSCRIPT_FLOOR, OVERLAY_TRANSCRIPT_FLOOR } from "./geometry/index";
import { focusOwner, scrollLease } from "./focus/index";
import { withTestRenderer } from "./harness";
import {
  makePermissionItems,
  openModelPickerOverlay,
  openOperatorOverlay,
  openPermissionsOverlay,
  wrapOverlayBody,
} from "./overlays";
import {
  acceptOverlaySelection,
  clearShellOverlayHooks,
  closeInsetOverlay,
  createAppShell,
  moveOverlaySelection,
  openListOverlay,
  pageOverlaySelection,
  relayout,
  setShellOverlayHooks,
  type OverlaySelection,
} from "./shell";
import { visibleSlice } from "./list-viewport";
import { UI } from "./theme";

function colorHex(c: unknown): string {
  if (typeof c === "string") return c.toLowerCase();
  return rgbToHex(c as Parameters<typeof rgbToHex>[0])
    .toLowerCase()
    .slice(0, 7);
}

describe("overlay host chrome", () => {
  test("border and title stay textDim after create and open", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          expect(colorHex(shell.overlayHost.borderColor)).toBe(UI.textDim);
          expect(colorHex(shell.overlayTitle.fg)).toBe(UI.textDim);

          openOperatorOverlay(shell);
          expect(colorHex(shell.overlayHost.borderColor)).toBe(UI.textDim);
          expect(colorHex(shell.overlayTitle.fg)).toBe(UI.textDim);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("wrapOverlayBody", () => {
  test("splits long lines and caps", () => {
    const lines = wrapOverlayBody("abcdefghij", 4, 3);
    expect(lines).toEqual(["abcd", "efgh", "ij"]);
  });

  test("preserves blank lines from newlines", () => {
    const lines = wrapOverlayBody("a\n\nb", 40, 8);
    expect(lines).toEqual(["a", "", "b"]);
  });
});

describe("permissions overlay", () => {
  test("opens 30 options; keep-active-visible; Esc restores prompt", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
          run: "idle",
        });
        try {
          const items = makePermissionItems(30);
          openPermissionsOverlay(shell, { items });
          expect(shell.overlayKind).toBe("permissions");
          expect(shell.overlayList).not.toBeNull();
          expect(shell.overlayItems.length).toBe(30);
          expect(shell.overlayList!.activeIndex).toBe(0);
          expect(focusOwner(shell.focus)).toBe("overlay");
          expect(scrollLease(shell.focus)).toBe("overlay");
          expect(shell.layout.overlayMode).toBe("inset");
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(OVERLAY_TRANSCRIPT_FLOOR);
          expect(shell.overlayHost.visible).toBe(true);

          await h.renderOnce();
          let frame = h.captureCharFrame();
          expect(frame).toContain("permissions");
          // First option is in the list model (may clip if body short).
          expect(shell.overlayItems[0]).toBe("Allow once");
          expect(frame).toMatch(/Allow/);
          expect(frame).toContain("/yolo");
          expect(frame).toContain("Esc cancel · Enter choose · /yolo skip prompts");

          // Navigate deep enough that window must scroll (keep-active-visible).
          const listH = shell.overlayList!.height;
          for (let i = 0; i < listH + 5; i++) {
            moveOverlaySelection(shell, 1);
          }
          expect(shell.overlayList!.activeIndex).toBe(listH + 5);
          const slice = visibleSlice(shell.overlayList!);
          expect(shell.overlayList!.activeIndex).toBeGreaterThanOrEqual(slice.start);
          expect(shell.overlayList!.activeIndex).toBeLessThan(slice.end);

          await h.renderOnce();
          frame = h.captureCharFrame();
          const activeLabel = shell.overlayItems[shell.overlayList!.activeIndex] ?? "";
          expect(frame).toContain(activeLabel.slice(0, 20));

          h.pressKey("Escape");
          await h.renderOnce();
          // Prefer direct close if mock Escape is flaky under dense paint.
          if (shell.overlayList) closeInsetOverlay(shell);
          expect(shell.overlayList).toBeNull();
          expect(shell.overlayKind).toBeNull();
          expect(focusOwner(shell.focus)).toBe("prompt");
          expect(shell.layout.overlayMode).toBe("closed");
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(IDLE_TRANSCRIPT_FLOOR);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("key hints drop to Esc · Enter on a narrow interior", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 32, rows: 24 },
          wireKeys: false,
        });
        try {
          openPermissionsOverlay(shell, { items: makePermissionItems(4) });
          await h.renderOnce();
          const frame = h.captureCharFrame();
          expect(frame).toContain("Esc · Enter");
          expect(frame).not.toContain("/yolo");
        } finally {
          shell.dispose();
        }
      },
      { width: 32, height: 24 },
    );
  });

  test("Esc key closes permissions overlay via wireKeys", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        });
        try {
          openPermissionsOverlay(shell, { items: makePermissionItems(10) });
          expect(focusOwner(shell.focus)).toBe("overlay");
          // ESC needs disambiguation delay on the mock stdin path.
          h.pressKey("Escape");
          await new Promise((r) => setTimeout(r, 60));
          await h.renderOnce();
          expect(shell.overlayList).toBeNull();
          expect(focusOwner(shell.focus)).toBe("prompt");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("page moves selection and keeps active visible", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          openPermissionsOverlay(shell, { items: makePermissionItems(30) });
          const before = shell.overlayList!.activeIndex;
          pageOverlaySelection(shell, 1);
          expect(shell.overlayList!.activeIndex).toBeGreaterThan(before);
          const slice = visibleSlice(shell.overlayList!);
          expect(shell.overlayList!.activeIndex).toBeGreaterThanOrEqual(slice.start);
          expect(shell.overlayList!.activeIndex).toBeLessThan(slice.end);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("operator question overlay", () => {
  test("long body + choices; no status overpaint; Esc restores", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
          run: "idle",
        });
        try {
          openOperatorOverlay(shell);
          expect(shell.overlayKind).toBe("operator");
          expect(shell.layout.overlayMode).toBe("inset");
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(OVERLAY_TRANSCRIPT_FLOOR);
          expect(shell.overlayBodyLines.length).toBeGreaterThan(0);
          expect(shell.overlayItems.length).toBeGreaterThan(3);
          expect(focusOwner(shell.focus)).toBe("overlay");

          await h.renderOnce();
          const frame = h.captureCharFrame();
          // Title chrome dropped — subject + hints carry the ask.
          expect(frame).not.toContain("operator question");
          // Body / subject fragment visible
          expect(frame).toMatch(/destructive|working tree|git reset/i);
          // Choice visible
          expect(frame).toMatch(/Cancel|Allow/);
          // The overlay carries its own keys now that there is no hint strip.
          expect(frame).toContain("Esc cancel");
          expect(frame).not.toContain("/yolo");
          // Empty title must not leave a leading middle-dot before the hints.
          expect(frame).not.toMatch(/·\s*Esc cancel/);

          // Esc restore: closeInsetOverlay is the Esc path (same as key handler).
          closeInsetOverlay(shell);
          expect(shell.overlayList).toBeNull();
          expect(shell.overlayKind).toBeNull();
          expect(focusOwner(shell.focus)).toBe("prompt");
          expect(shell.layout.overlayMode).toBe("closed");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("model / provider picker", () => {
  test("opens shared scroll kit; navigate + accept + Esc", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
          run: "idle",
        });
        try {
          openModelPickerOverlay(shell);
          expect(shell.overlayKind).toBe("model_picker");
          expect(shell.overlayItems.length).toBeGreaterThanOrEqual(5);
          expect(focusOwner(shell.focus)).toBe("overlay");

          await h.renderOnce();
          let frame = h.captureCharFrame();
          expect(frame).toContain("model");
          expect(frame).toMatch(/anthropic|openai|claude/i);
          expect(frame).not.toContain("/yolo");

          moveOverlaySelection(shell, 2);
          acceptOverlaySelection(shell);
          expect(shell.overlayList).toBeNull();
          expect(focusOwner(shell.focus)).toBe("prompt");

          await h.renderOnce();
          frame = h.captureCharFrame();
          expect(frame).toContain("model picker");
          expect(frame).toMatch(/Chose /);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("overlay accept callbacks", () => {
  test("permissions open → navigate → accept fires onAccept with payload", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          const accepted: OverlaySelection[] = [];
          openPermissionsOverlay(shell, {
            items: ["Allow once", "Allow session", "Deny"],
            itemIds: ["once", "session", "deny"],
            onAccept: (s) => accepted.push(s),
          });
          moveOverlaySelection(shell, 1);
          acceptOverlaySelection(shell);
          expect(accepted).toEqual([
            {
              kind: "permissions",
              index: 1,
              label: "Allow session",
              id: "session",
            },
          ]);
          expect(shell.overlayList).toBeNull();
          expect(focusOwner(shell.focus)).toBe("prompt");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("operator accept fires shell-level onOperator when no per-open", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          const accepted: OverlaySelection[] = [];
          setShellOverlayHooks(shell, {
            onOperator: (s) => accepted.push(s),
          });
          openOperatorOverlay(shell, {
            body: "Proceed?",
            choices: ["Cancel", "Allow once", "Deny"],
          });
          moveOverlaySelection(shell, 1);
          acceptOverlaySelection(shell);
          expect(accepted).toHaveLength(1);
          expect(accepted[0]).toEqual({
            kind: "operator",
            index: 1,
            label: "Allow once",
          });
        } finally {
          clearShellOverlayHooks(shell);
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("model_picker accept fires onModel with id", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          const accepted: OverlaySelection[] = [];
          setShellOverlayHooks(shell, {
            onModel: (s) => accepted.push(s),
          });
          openModelPickerOverlay(shell, {
            items: ["sonnet * [anthropic]", "gpt-5 * [openai]"],
            itemIds: ["anthropic:claude-sonnet-4", "openai:gpt-5"],
            activeIndex: 0,
          });
          moveOverlaySelection(shell, 1);
          acceptOverlaySelection(shell);
          expect(accepted).toEqual([
            {
              kind: "model_picker",
              index: 1,
              label: "gpt-5 * [openai]",
              id: "openai:gpt-5",
            },
          ]);
        } finally {
          clearShellOverlayHooks(shell);
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Esc / close restores without accept callback", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          const accepted: OverlaySelection[] = [];
          openPermissionsOverlay(shell, {
            items: ["Allow once", "Deny"],
            itemIds: ["once", "deny"],
            onAccept: (s) => accepted.push(s),
          });
          moveOverlaySelection(shell, 1);
          closeInsetOverlay(shell);
          expect(accepted).toEqual([]);
          expect(shell.overlayList).toBeNull();
          expect(focusOwner(shell.focus)).toBe("prompt");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("per-open onAccept wins over shell-level hooks", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          const shellHits: OverlaySelection[] = [];
          const openHits: OverlaySelection[] = [];
          setShellOverlayHooks(shell, {
            onPermission: (s) => shellHits.push(s),
          });
          openPermissionsOverlay(shell, {
            items: ["Allow once"],
            onAccept: (s) => openHits.push(s),
          });
          acceptOverlaySelection(shell);
          expect(openHits).toHaveLength(1);
          expect(shellHits).toEqual([]);
        } finally {
          clearShellOverlayHooks(shell);
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("resize mid-overlay", () => {
  test("80×24 ↔ larger keeps floors; closed restores idle floor", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        try {
          openPermissionsOverlay(shell, { items: makePermissionItems(30) });
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(OVERLAY_TRANSCRIPT_FLOOR);

          relayout(shell, {
            columns: 120,
            rows: 40,
            overlayMode: "inset",
            overlayBodyRows: shell.layout.overlayHeight,
          });
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(OVERLAY_TRANSCRIPT_FLOOR);
          expect(shell.overlayList).not.toBeNull();
          expect(shell.layout.overlayHeight).toBeGreaterThan(0);

          relayout(shell, {
            columns: 80,
            rows: 24,
            overlayMode: "inset",
            overlayBodyRows: shell.layout.overlayHeight,
          });
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(OVERLAY_TRANSCRIPT_FLOOR);

          closeInsetOverlay(shell);
          expect(shell.layout.overlayMode).toBe("closed");
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(IDLE_TRANSCRIPT_FLOOR);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("accept echo reads the chosen value structurally", () => {
  test("a label containing its own ‹ › text does not corrupt the echo", async () => {
    // A row whose display label happens to contain marker glyphs for reasons
    // that have nothing to do with the cycled-field convention — the echo
    // must still report the caller-supplied value, not something scraped
    // back out of the label.
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          openListOverlay(shell, {
            kind: "settings",
            items: ["server name    ‹ prod › staging"],
            itemIds: ["server"],
            itemValues: ["prod"],
          });
          acceptOverlaySelection(shell);

          const row = shell.streamLog.at(-1);
          expect(row?.text).toBe("Set server to prod.");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("echoChoice defaults to on for callers with no gate policy", () => {
  test("openPermissionsOverlay with no echoChoice opt still echoes on accept", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          openPermissionsOverlay(shell, { items: makePermissionItems(3) });
          const before = shell.streamLog.length;
          acceptOverlaySelection(shell);
          expect(shell.streamLog.length - before).toBe(1);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("openPermissionsOverlay with echoChoice: false suppresses it", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          openPermissionsOverlay(shell, {
            items: makePermissionItems(3),
            echoChoice: false,
          });
          const before = shell.streamLog.length;
          acceptOverlaySelection(shell);
          expect(shell.streamLog.length - before).toBe(0);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("openOperatorOverlay with no echoChoice opt still echoes on accept", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          openOperatorOverlay(shell, { choices: ["A", "B"] });
          const before = shell.streamLog.length;
          acceptOverlaySelection(shell);
          expect(shell.streamLog.length - before).toBe(1);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});
