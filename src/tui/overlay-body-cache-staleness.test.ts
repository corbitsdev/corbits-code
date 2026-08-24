/**
 * CL-5750 follow-up: a palette stacked over an open approval must not
 * clobber the approval's cached raw body text, which a resize re-shapes
 * against the new height's context budget (see `decisionContextBudget` /
 * `applyOverlayBodyText` in shell.ts).
 */
import { describe, expect, test } from "bun:test";
import { withTestRenderer } from "./harness.js";
import {
  createAppShell,
  appendStreamRow,
  closeInsetOverlay,
  openPalette,
  type AppShell,
} from "./shell.js";
import { openPermissionsOverlay, makePermissionItems } from "./overlays.js";

function primeSession(shell: AppShell): void {
  appendStreamRow(shell, { role: "assistant", text: "session underway" });
}

describe("decision overlay body cache survives a stacked palette", () => {
  test("resize after popping a stacked palette re-shapes the approval's own body, not a blanked one", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        });
        try {
          primeSession(shell);
          openPermissionsOverlay(shell, {
            items: makePermissionItems(3),
            body: "run_shell\nRun shell command\nSome context about the risky command.",
          });
          await h.renderOnce();
          expect(shell.overlayBodyLines.length).toBeGreaterThan(0);

          // Stack a palette over the open permissions overlay — its own
          // (empty) body must not overwrite the approval's cached raw text.
          openPalette(shell, {
            catalog: [{ id: "foo", label: "foo" }],
            title: "commands",
          });
          await h.renderOnce();
          expect(shell.overlayKind).toBe("palette");

          // Pop the palette back to the permissions overlay underneath.
          closeInsetOverlay(shell);
          await h.renderOnce();
          expect(shell.overlayKind).toBe("permissions");
          expect(shell.overlayBodyLines.length).toBeGreaterThan(0);

          // Resize: the body must still show the permission context, not be
          // blanked by re-shaping from the palette's stale empty cache.
          h.resize(80, 20);
          await h.renderOnce();
          await h.renderOnce();
          expect(shell.overlayBodyLines.length).toBeGreaterThan(0);
          expect(shell.overlayBodyLines.join("\n")).toContain("run_shell");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});
