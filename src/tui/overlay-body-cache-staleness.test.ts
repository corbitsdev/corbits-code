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
import { DECISION_CHOICE_ROWS } from "./overlay-body.js";

function primeSession(shell: AppShell): void {
  appendStreamRow(shell, { role: "assistant", text: "session underway" });
}

describe("decision overlay body cache survives a stacked palette", () => {
  test("resize after popping a stacked palette re-shapes the approval's own body, not a blanked one", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 32 },
          run: "idle",
        });
        try {
          primeSession(shell);
          const items = makePermissionItems(3);
          openPermissionsOverlay(shell, {
            items,
            body: "run_shell\nRun shell command\nSome context about the risky command.",
          });
          await h.renderOnce();
          expect(shell.overlayBodyLines.length).toBeGreaterThan(0);
          const hostBefore = shell.layout.overlayHeight;
          // Chrome is border (2) + title (1) + body lines; list is N * perItem.
          expect(hostBefore).toBe(
            shell.overlayBodyLines.length + 3 + items.length * DECISION_CHOICE_ROWS,
          );

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
          expect(shell.layout.overlayHeight).toBe(hostBefore);
          expect(shell.overlayList?.height).toBe(items.length);

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
      { width: 80, height: 32 },
    );
  });
});
