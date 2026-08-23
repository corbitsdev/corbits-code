import { expect, test } from "bun:test";

import { withTestRenderer } from "./harness";
import { appendStreamRow, closeInsetOverlay, createAppShell } from "./shell";
import { openModelPickerOverlay } from "./overlays";
import type { PaletteCommand } from "./command-catalog";

const CATALOG: readonly PaletteCommand[] = [
  { id: "model", label: "/model" },
  { id: "mcp", label: "/mcp" },
];

// Regression: the overlay host floats absolutely over the landing (top set to
// a large row offset) but is an in-flow band once a transcript exists.
// Un-floating used to leave the absolute insets behind, and under relative
// positioning a stale top offsets the band downward — the slash popup rendered
// below the prompt, clipped off the bottom of the screen.
test("slash popup stays above the prompt after a landing-floated overlay", async () => {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 120, rows: 50 },
        wireKeys: true,
        run: "idle",
        paletteCatalog: CATALOG,
      });
      try {
        // Landing: overlay floats absolutely with a large top offset.
        openModelPickerOverlay(shell, { items: ["codex/def / gpt-5.6-sol"] });
        await h.renderOnce();
        closeInsetOverlay(shell);
        await h.renderOnce();

        // Transcript starts; overlays are in-flow bands from here on.
        appendStreamRow(shell, { role: "user", text: "hi" });
        appendStreamRow(shell, { role: "assistant", text: "Hi! What can I help you with?" });
        await h.renderOnce();

        h.pressKey("/");
        h.pressKey("m");
        h.pressKey("o");
        await h.renderOnce();
        const frame = h.captureCharFrame();
        const lines = frame.split("\n");
        const popupRow = lines.findIndex((l) => l.includes("/model"));
        const promptRow = lines.findIndex((l) => l.includes("/mo") && !l.includes("/model"));
        expect(popupRow).toBeGreaterThanOrEqual(0);
        expect(promptRow).toBeGreaterThanOrEqual(0);
        expect(popupRow).toBeLessThan(promptRow);
      } finally {
        shell.dispose();
      }
    },
    { width: 120, height: 50 },
  );
});
