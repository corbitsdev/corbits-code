/**
 * With a suggestion/picker list open, keystrokes the list doesn't use are
 * silently dropped instead of reaching the prompt — typed filter text can
 * vanish without feedback. Unclaimed printables must reach the prompt
 * buffer, whether the open surface is a plain picker or an ephemeral popup.
 */
import { describe, expect, test } from "bun:test";

import { withTestRenderer } from "./harness";
import type { KeyEvent } from "@opentui/core";
import type { PaletteCommand } from "./command-catalog";
import { openPermissionsOverlay, openOperatorOverlay } from "./overlays";
import { createAppShell } from "./shell/index";
import type { AppShell } from "./shell/internals";
import { isSlashPopupOpen } from "./shell/internals";
import { openListOverlay } from "./shell/overlay-host";
import { runOverlayAction } from "./shell/overlay-list";
import {
  handleListFilterKey,
  openHelpOverlay,
  openPalette,
} from "./shell/palette";

const CATALOG: readonly PaletteCommand[] = [
  { id: "model", label: "/model" },
  { id: "mcp", label: "/mcp" },
];

interface Ctx {
  readonly shell: AppShell;
  readonly press: (key: string) => void;
}

function withShell(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  return withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: true,
        run: "idle",
        paletteCatalog: CATALOG,
      });
      try {
        await fn({
          shell,
          press: (key) => h.pressKey(key as Parameters<typeof h.pressKey>[0]),
        });
      } finally {
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
}

describe("unclaimed overlay keys reach the prompt", () => {
  test("printable a non-filter picker ignores lands in the prompt", async () => {
    await withShell(async ({ shell, press }) => {
      openHelpOverlay(shell);
      expect(shell.overlayList).not.toBeNull();
      expect(shell.overlayKind).toBe("help");

      press("x");
      expect(shell.prompt.value).toBe("x");
      expect(shell.overlayKind).toBe("help");
    });
  });

  test("palette symmetry: unclaimed printable with a palette open reaches the prompt via the fallthrough", async () => {
    await withShell(async ({ shell, press }) => {
      openPalette(shell, { catalog: CATALOG });
      expect(shell.overlayKind).toBe("palette");
      expect(isSlashPopupOpen(shell)).toBe(false);

      press("x");
      expect(shell.prompt.value).toBe("x");
      expect(shell.overlayKind).toBe("palette");
    });
  });

  test("permission gate keeps printable keys: prompt stays empty, gate stays open", async () => {
    await withShell(async ({ shell, press }) => {
      openPermissionsOverlay(shell, { items: ["Allow once", "Deny"] });
      expect(shell.overlayKind).toBe("permissions");

      press("x");
      expect(shell.prompt.value).toBe("");
      expect(shell.overlayKind).toBe("permissions");
    });
  });

  test("operator gate keeps printable keys: prompt stays empty, gate stays open", async () => {
    await withShell(async ({ shell, press }) => {
      openOperatorOverlay(shell, {
        body: "Proceed?",
        choices: ["Cancel", "Continue"],
      });
      expect(shell.overlayKind).toBe("operator");

      press("x");
      expect(shell.prompt.value).toBe("");
      expect(shell.overlayKind).toBe("operator");
    });
  });

  test("claimed overlay keys keep precedence over the prompt", async () => {
    await withShell(async ({ shell, press }) => {
      openHelpOverlay(shell);
      const before = shell.overlayList?.activeIndex ?? 0;

      press("j");
      expect(shell.overlayList?.activeIndex).toBe(before + 1);
      expect(shell.prompt.value).toBe("");
    });
  });
});

/** A composed Option glyph with no modifier bits (shape B, Option+D → ∂). */
function glyphKey(glyph: string): KeyEvent {
  return {
    name: glyph,
    sequence: glyph,
    ctrl: false,
    meta: false,
    option: false,
  } as KeyEvent;
}

describe("declared altChords drive filter yield and dispatch (CL-8637)", () => {
  test("a declared glyph yields the type-to-filter and routes to onAltChord", async () => {
    await withShell(async ({ shell }) => {
      const chords: string[] = [];
      openListOverlay(shell, {
        kind: "model_picker",
        items: ["alpha", "beta"],
        itemIds: ["a", "b"],
        typeToFilter: true,
        altChords: ["d"],
        onAltChord: (itemId, letter) => {
          chords.push(`${itemId}:${letter}`);
          return true;
        },
      });

      const composed = glyphKey("∂");
      expect(handleListFilterKey(shell, composed)).toBe(false);
      expect(runOverlayAction(shell, composed)).toBe(true);
      expect(chords).toEqual(["a:d"]);
      expect(shell.overlayItems).toEqual(["alpha", "beta"]);
      expect(shell.prompt.value).toBe("");
    });
  });

  test("the same glyph stays filter text on a surface that did not declare it (I-3)", async () => {
    await withShell(async ({ shell, press }) => {
      openListOverlay(shell, {
        kind: "model_picker",
        items: ["alpha", "beta"],
        itemIds: ["a", "b"],
        typeToFilter: true,
      });

      press("∂");
      expect(shell.overlayItems).toEqual(["(no matches)"]);
      expect(shell.prompt.value).toBe("");
    });
  });

  test("onAltChord returning false leaves the key to the later handlers", async () => {
    await withShell(async ({ shell, press }) => {
      const chords: string[] = [];
      openListOverlay(shell, {
        items: ["alpha"],
        itemIds: ["a"],
        altChords: ["d"],
        onAltChord: (itemId, letter) => {
          chords.push(`${itemId}:${letter}`);
          return false;
        },
      });

      press("∂");
      expect(chords).toEqual(["a:d"]);
      // Refused by the chord handler, the glyph behaves like any unclaimed
      // printable: it reaches the prompt, exactly as before this change.
      expect(shell.prompt.value).toBe("∂");
    });
  });

  test("no overlay open: composed option glyphs type, never translate (I-6)", async () => {
    await withShell(async ({ shell, press }) => {
      press("∂");
      press("´");
      expect(shell.prompt.value).toBe("∂´");
      expect(shell.overlayList).toBeNull();
    });
  });

  test("the `/` popup claims declared chord glyphs as filter text (I-5)", async () => {
    await withShell(async ({ shell, press }) => {
      press("/");
      expect(isSlashPopupOpen(shell)).toBe(true);
      press("∂");
      expect(shell.prompt.value).toBe("/∂");
      expect(isSlashPopupOpen(shell)).toBe(true);
    });
  });
});
