/**
 * URL click-through (CL-7346): Ctrl+click opens an http(s) URL in the
 * default browser; a plain click keeps today's row behavior.
 *
 * The opener is mocked (setUrlOpener) — no test spawns a real browser.
 * Whether a real terminal reports the Ctrl modifier is a harness blind
 * spot (docs/TUI.md); headless, the mock delivers it like any click.
 */
import { describe, expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";

import { defined } from "../../tests/helpers/defined.js";
import { withTestRenderer } from "./harness";
import { appendStreamRow } from "./shell/chrome";
import { createAppShell } from "./shell/index";
import {
  isUnderlined,
  paintLinkLine,
  resetUrlOpener,
  setUrlOpener,
  splitLinkSpans,
} from "./url-links";
import { type StreamRow } from "./stream";

const CALL: StreamRow = {
  role: "tool",
  text: "",
  meta: "web_fetch",
  verb: "Web Fetch",
  summary: "see https://www.example.com/docs for details",
  detail: [[{ text: "url: https://www.example.com/docs", fg: "#f7ead5" }]],
};

/** Screen position of the first cell of `needle`, or null when not painted. */
function findCell(
  frame: string,
  needle: string,
): { readonly x: number; readonly y: number } | null {
  const lines = frame.split("\n");
  for (const [y, line] of lines.entries()) {
    const x = line.indexOf(needle);
    if (x !== -1) return { x, y };
  }
  return null;
}

describe("Ctrl+clicking a transcript URL", () => {
  test("opens it, while plain click and Ctrl+drag do not", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const opened: string[] = [];
        setUrlOpener((url) => {
          opened.push(url);
        });
        try {
          appendStreamRow(shell, CALL);
          await h.renderOnce();

          const link = findCell(h.captureCharFrame(), "example.com");
          expect(link).not.toBeNull();
          const at = defined(link);

          await h.mockMouse.click(at.x, at.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual(["https://www.example.com/docs"]);

          opened.length = 0;
          await h.mockMouse.click(at.x, at.y);
          await h.renderOnce();
          expect(opened).toEqual([]);
          expect(shell.streamLog[0]?.expanded).not.toBe(true);

          await h.mockMouse.drag(at.x, at.y, at.x + 12, at.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual([]);
        } finally {
          resetUrlOpener();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Ctrl+hover underlines the link until the pointer leaves it", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        try {
          appendStreamRow(shell, CALL);
          await h.renderOnce();

          const link = findCell(h.captureCharFrame(), "example.com");
          expect(link).not.toBeNull();
          const at = defined(link);

          const linkSpanUnderlined = (): boolean =>
            defined(h.captureSpans().lines[at.y]).spans.some(
              (span) =>
                span.text.includes("example.com") &&
                isUnderlined(span.attributes),
            );

          await h.mockMouse.moveTo(at.x, at.y, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(linkSpanUnderlined()).toBe(true);

          await h.mockMouse.moveTo(at.x, at.y);
          await h.renderOnce();
          expect(linkSpanUnderlined()).toBe(false);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("retexting the URL away disarms the node: old columns open nothing", async () => {
    await withTestRenderer(
      async (h) => {
        const opened: string[] = [];
        setUrlOpener((url) => {
          opened.push(url);
        });
        try {
          const line = "see https://example.com/x ok";
          const node = new TextRenderable(h.renderer, { content: line });
          h.root.add(node);
          paintLinkLine(node, [splitLinkSpans([{ text: line, fg: "#fff" }])]);
          await h.renderOnce();

          const link = findCell(h.captureCharFrame(), "example.com");
          expect(link).not.toBeNull();
          const at = defined(link);

          await h.mockMouse.click(at.x, at.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual(["https://example.com/x"]);

          // Retext the URL away, exactly as the row retext path does. The
          // handlers are setter-only (no getter to assert on), so pin the
          // disarm behaviorally: the old columns open nothing and hover
          // leaves the painted text intact.
          const retexted = "see nothing here";
          paintLinkLine(node, [
            splitLinkSpans([{ text: retexted, fg: "#fff" }]),
          ]);
          await h.renderOnce();
          const frame = h.captureCharFrame();
          expect(frame).toContain("nothing here");
          expect(frame).not.toContain("example.com");

          opened.length = 0;
          await h.mockMouse.click(at.x, at.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual([]);

          const before = h.captureCharFrame();
          await h.mockMouse.moveTo(at.x, at.y, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(h.captureCharFrame()).toBe(before);
        } finally {
          resetUrlOpener();
        }
      },
      { width: 80, height: 24 },
    );
  });
});
