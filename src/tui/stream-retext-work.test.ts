/**
 * Frame retext must not resplit an unchanged body, rewalk code links, or
 * copy the transcript child list to find the open row.
 */
import { describe, expect, test } from "bun:test";
import {
  CodeRenderable,
  MarkdownRenderable,
  type BaseRenderable,
} from "@opentui/core";
import { withTestRenderer } from "./harness";
import { codeLinkArmWalks } from "./code-links";
import { appendStreamRow, replaceStreamRowAt } from "./shell/chrome";
import { createAppShell } from "./shell/index";
import { transcriptRowChildren } from "./shell/transcript";

const SHELL_OPTS = {
  terminal: { columns: 80, rows: 24 },
  wireKeys: false,
  run: "idle",
} as const;

const SETTLED = "### Title\n\n```bash\necho hi\n```\n\ntail";

function codeNodes(node: BaseRenderable): CodeRenderable[] {
  const found: CodeRenderable[] = [];
  const walk = (current: BaseRenderable): void => {
    if (current instanceof CodeRenderable) found.push(current);
    for (const child of current.getChildren()) walk(child);
  };
  walk(node);
  return found;
}

describe("streaming retext work", () => {
  test("an in-place retext does not call getChildren to find the row", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, SHELL_OPTS);
        try {
          appendStreamRow(shell, {
            role: "assistant",
            streaming: true,
            text: "hello",
          });
          await h.renderOnce();
          const node = transcriptRowChildren(shell)[0];
          let calls = 0;
          const original = shell.transcript.getChildren.bind(shell.transcript);
          shell.transcript.getChildren = () => {
            calls += 1;
            return original();
          };
          replaceStreamRowAt(shell, 0, {
            role: "assistant",
            streaming: true,
            text: "hello!",
          });
          const during = calls;
          shell.transcript.getChildren = original;
          expect(during).toBe(0);
          expect(transcriptRowChildren(shell)[0]).toBe(node);
          expect(shell.streamLog[0]?.text).toBe("hello!");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("code links arm when a block is added, not on every tail retext", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, SHELL_OPTS);
        try {
          appendStreamRow(shell, {
            role: "assistant",
            streaming: true,
            text: SETTLED,
          });
          await h.renderOnce();
          const before = codeLinkArmWalks();
          let text = SETTLED;
          for (let i = 0; i < 4; i += 1) {
            text += ` ${i}`;
            replaceStreamRowAt(shell, 0, {
              role: "assistant",
              streaming: true,
              text,
            });
          }
          expect(codeLinkArmWalks() - before).toBe(0);

          const beforeBlock = codeLinkArmWalks();
          text += "\n\n```js\nconst n = 1;\n```\n\nmore";
          replaceStreamRowAt(shell, 0, {
            role: "assistant",
            streaming: true,
            text,
          });
          const added = codeLinkArmWalks() - beforeBlock;
          expect(added).toBeGreaterThan(0);
          expect(added).toBeLessThanOrEqual(2);

          const after = codeLinkArmWalks();
          replaceStreamRowAt(shell, 0, {
            role: "assistant",
            streaming: true,
            text: `${text} still`,
          });
          expect(codeLinkArmWalks()).toBe(after);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("prose rewritten as one fenced URL block arms that code node", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, SHELL_OPTS);
        try {
          appendStreamRow(shell, {
            role: "assistant",
            streaming: true,
            text: "hello",
          });
          await h.renderOnce();
          const before = codeLinkArmWalks();
          replaceStreamRowAt(shell, 0, {
            role: "assistant",
            streaming: true,
            text: "```js\nhttps://example.com\n```",
          });
          const row = transcriptRowChildren(shell)[0];
          if (row === undefined) throw new Error("row missing");
          const codes = codeNodes(row);
          expect(codes).toHaveLength(1);
          const code = codes[0];
          if (code === undefined) throw new Error("code node missing");
          expect(code.onChunks).toBeDefined();
          expect(code.onHighlight).toBeDefined();
          expect(codeLinkArmWalks()).toBeGreaterThan(before);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("a fence added under a stable list still arms that code node", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, SHELL_OPTS);
        try {
          appendStreamRow(shell, {
            role: "assistant",
            streaming: true,
            text: "- intro",
          });
          await h.renderOnce();
          const row = transcriptRowChildren(shell)[0];
          if (row === undefined) throw new Error("row missing");
          const markdown = row
            .getChildren()
            .find((child) => child instanceof MarkdownRenderable);
          if (!(markdown instanceof MarkdownRenderable)) {
            throw new Error("markdown missing");
          }
          // OpenTUI keeps one list box and inserts the fence under it. The
          // first retext arms that box; the fence must still be walked.
          markdown.internalBlockMode = "top-level";
          replaceStreamRowAt(shell, 0, {
            role: "assistant",
            streaming: true,
            text: "- intro",
          });
          const list = markdown.getChildren()[0];
          if (list === undefined || list instanceof CodeRenderable) {
            throw new Error("list box missing");
          }
          const before = codeLinkArmWalks();
          replaceStreamRowAt(shell, 0, {
            role: "assistant",
            streaming: true,
            text: "- intro\n\n  ```\n  https://example.com\n  ```",
          });
          expect(markdown.getChildren()[0]).toBe(list);
          const codes = codeNodes(row);
          const fence = codes.find(
            (code) =>
              code.onChunks === undefined || code.filetype !== "markdown",
          );
          expect(fence).toBeDefined();
          expect(fence?.onChunks).toBeDefined();
          expect(fence?.onHighlight).toBeDefined();
          expect(codeLinkArmWalks()).toBeGreaterThan(before);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});
