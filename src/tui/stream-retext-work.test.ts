/**
 * Frame retext must not resplit an unchanged body, rewalk code links, or
 * copy the transcript child list to find the open row.
 */
import { describe, expect, test } from "bun:test";
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
});
