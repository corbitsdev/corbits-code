/**
 * CL-5596: a missing surface dependency must produce an honest empty state,
 * never the hardcoded rows from residuals.ts rendered as if they were real.
 */
import { describe, expect, test } from "bun:test";

import {
  openSettingsSurface,
  type CommandSurfaceDeps,
} from "./command-surfaces.js";
import { withTestRenderer } from "./harness.js";
import { createAppShell } from "./shell/index.js";
import { closeInsetOverlay } from "./shell/overlay-host.js";
import {
  openModelPickerOverlay,
  openOperatorOverlay,
  openPermissionsOverlay,
} from "./overlays.js";

describe("overlay dependency gaps never render fixture content", () => {
  test("settings surface without a settings dependency shows no fabricated rows", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        });
        try {
          const notified: string[] = [];
          const deps: CommandSurfaceDeps = {
            notify: (text) => notified.push(text),
          };

          openSettingsSurface(shell, deps);

          expect(shell.overlayItems).not.toContain(
            "Permissions — revoke remembered approvals",
          );
          expect(shell.overlayItems).not.toContain(
            "Compaction — summarize vs drop",
          );
          expect(notified.length).toBeGreaterThan(0);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("list overlays have no fallback rows — only the caller's items render", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        });
        try {
          openPermissionsOverlay(shell, { items: ["Allow once", "Deny"] });
          expect(shell.overlayItems).toEqual(["Allow once", "Deny"]);
          closeInsetOverlay(shell);

          openModelPickerOverlay(shell, { items: ["grok-3 * [xai]"] });
          expect(shell.overlayItems).toEqual(["grok-3 * [xai]"]);
          closeInsetOverlay(shell);

          openOperatorOverlay(shell, {
            body: "proceed?",
            choices: ["yes", "no"],
          });
          expect(shell.overlayItems).toEqual(["yes", "no"]);

          // The deleted demo fixtures must not leak back in anywhere.
          expect(
            shell.overlayItems.some((item) =>
              item.startsWith("Allow tool call #"),
            ),
          ).toBe(false);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});
