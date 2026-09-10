/**
 * In-place retext keeps a row's paint node when only its state flips — most
 * importantly the gutter voice: a tool row that fails after being painted
 * pending must dim its gutter on the same node, not keep the live bronze.
 */
import { describe, expect, test } from "bun:test";
import { defined } from "../../tests/helpers/defined.js";
import {
  BoxRenderable,
  TextRenderable,
  parseColor,
  rgbToHex,
  type ColorInput,
} from "@opentui/core";
import { withTestRenderer } from "./harness";
import { appendStreamRow, replaceStreamRowAt } from "./shell/chrome";
import { createAppShell } from "./shell/index";
import { transcriptRowChildren } from "./shell/transcript";
import { UI } from "./theme";
import { pushToolCall, pushToolResult } from "./tool-rows";
import type { StreamRow } from "./stream";

const SHELL_OPTS = {
  terminal: { columns: 100, rows: 24 },
  wireKeys: false,
  run: "idle",
} as const;

const gutterOf = (node: unknown): TextRenderable => {
  if (!(node instanceof BoxRenderable)) throw new Error("row node is not a wrapper");
  const [gutter] = node.getChildren();
  if (!(gutter instanceof TextRenderable)) throw new Error("first child is not the gutter");
  return gutter;
};

/** The node normalizes fg to an RGBA; compare it to the hex token exactly. */
const fgIs = (gutter: TextRenderable, hex: string): boolean =>
  rgbToHex(parseColor(gutter.fg as ColorInput)) === hex;

describe("retext gutter voice", () => {
  test("a tool row that fails after being painted pending dims its gutter in place", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, SHELL_OPTS);
        try {
          const rows: StreamRow[] = [];
          pushToolCall(rows, {
            name: "fetch",
            arguments: JSON.stringify({ url: "https://x.dev" }),
          });
          const pending = defined(rows[0]);
          expect(pending.pending).toBe(true);
          appendStreamRow(shell, pending);
          await h.renderOnce();
          const wrapper = transcriptRowChildren(shell)[0];
          const gutter = gutterOf(wrapper);
          const fgToken = `${gutter.fg}`;
          expect(fgToken).not.toBe(UI.textDim);
          expect(fgIs(gutter, UI.textDim)).toBe(false);

          pushToolResult(rows, { name: "fetch", content: "", isError: true });
          const failed = defined(rows[0]);
          expect(failed.failed).toBe(true);
          replaceStreamRowAt(shell, 0, failed);
          // Same paint node, same shape: the flip retexted rather than rebuilt.
          expect(transcriptRowChildren(shell)[0]).toBe(wrapper);
          expect(fgIs(gutter, UI.textDim)).toBe(true);
          await h.renderOnce();
        } finally {
          shell.dispose();
        }
      },
      { width: 100, height: 24 },
    );
  });
});
