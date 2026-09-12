/**
 * CL-6986: an approval on a terminal shorter than the 10-row guarantee must
 * still be answerable. Geometry may steal from the prompt floor; the painted
 * overlay border must close; at least one choice row must appear in the frame.
 */

import { describe, expect, test } from "bun:test";
import { makePermissionItems, withTestRenderer } from "./harness.js";
import {
  OVERLAY_MIN_ROWS,
  PROMPT_BASE_ROWS,
  resolveGeometry,
} from "./geometry/index.js";
import { appendStreamRow } from "./shell/chrome.js";
import { createAppShell } from "./shell/index.js";
import type { AppShell } from "./shell/internals.js";
import { openPermissionsOverlay } from "./overlays.js";

const WIDTH = 80;
const HEIGHTS = [6, 7, 9] as const;
const MIN_APPROVAL_ROWS = 7;

const APPROVAL_BODY = [
  "run_shell",
  "Run shell command",
  "This is context describing what the tool is about to do to the workspace.",
].join("\n");

function primeSession(shell: AppShell): void {
  appendStreamRow(shell, { role: "assistant", text: "session underway" });
}

function overlayBorderLines(frame: string): {
  readonly top: number;
  readonly bottom: number;
  readonly lines: readonly string[];
} {
  const lines = frame.replace(/\n$/, "").split("\n");
  const top = lines.findIndex((l) => l.trimStart().startsWith("┌"));
  const bottom = lines.findIndex(
    (l, i) => i > top && l.trimStart().startsWith("└"),
  );
  return { top, bottom, lines };
}

describe("resolveGeometry — best-effort overlay minimum", () => {
  for (const rows of HEIGHTS) {
    test(`grants minOverlay on a ${rows}-row terminal, stealing from the prompt if needed`, () => {
      const layout = resolveGeometry({
        terminal: { columns: WIDTH, rows },
        overlay: {
          mode: "inset",
          bodyRows: 48,
          minBodyRows: MIN_APPROVAL_ROWS,
        },
      });
      const granted = Math.min(MIN_APPROVAL_ROWS, rows);
      expect(layout.overlayHeight).toBeGreaterThanOrEqual(granted);
      expect(
        layout.chromeHeight + layout.overlayHeight + layout.transcriptHeight,
      ).toBe(rows);
      if (rows < MIN_APPROVAL_ROWS + PROMPT_BASE_ROWS) {
        expect(layout.heights.prompt).toBeLessThan(PROMPT_BASE_ROWS);
      }
    });

    test(`never sizes an open overlay below OVERLAY_MIN_ROWS when a ${rows}-row terminal can seat it`, () => {
      const layout = resolveGeometry({
        terminal: { columns: WIDTH, rows },
        overlay: { mode: "inset", bodyRows: 48 },
      });
      expect(layout.overlayHeight).toBeGreaterThanOrEqual(
        Math.min(OVERLAY_MIN_ROWS, rows),
      );
    });
  }
});

describe("approval overlay remains answerable below 10 rows", () => {
  for (const height of HEIGHTS) {
    test(`closed overlay border and a painted choice at ${height} rows`, async () => {
      await withTestRenderer(
        async (h) => {
          const shell = createAppShell(h.renderer, {
            terminal: { columns: WIDTH, rows: height },
            run: "idle",
          });
          try {
            primeSession(shell);
            openPermissionsOverlay(shell, {
              items: makePermissionItems(6),
              body: APPROVAL_BODY,
            });
            await h.renderOnce();
            await h.renderOnce();
            const frame = h.captureCharFrame();
            const { top, bottom, lines } = overlayBorderLines(frame);

            expect(lines.length).toBeLessThanOrEqual(height);
            expect(top).toBeGreaterThanOrEqual(0);
            expect(bottom).toBeGreaterThan(top);
            expect(bottom).toBeLessThan(lines.length);

            const borderOnly = /^[┌└├┬┐┘─┤┴]+$/;
            for (const idx of [top, bottom]) {
              const trimmed = lines[idx]?.trim() ?? "";
              expect(borderOnly.test(trimmed)).toBe(true);
            }

            expect(frame).toContain("Allow once");
          } finally {
            shell.dispose();
          }
        },
        { width: WIDTH, height },
      );
    });
  }
});
