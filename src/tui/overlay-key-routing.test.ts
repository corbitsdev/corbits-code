/**
 * With a suggestion/picker list open, keystrokes the list doesn't use are
 * silently dropped instead of reaching the prompt — typed filter text can
 * vanish without feedback. Unclaimed printables must reach the prompt
 * buffer, whether the open surface is a plain picker or an ephemeral popup.
 */
import { describe, expect, test } from "bun:test";

import { withTestRenderer } from "./harness";
import type { PaletteCommand } from "./command-catalog";
import { openPermissionsOverlay, openOperatorOverlay } from "./overlays";
import { createAppShell } from "./shell/index";
import type { AppShell } from "./shell/internals";
import { isSlashPopupOpen } from "./shell/internals";
import { openHelpOverlay, openPalette } from "./shell/palette";

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
