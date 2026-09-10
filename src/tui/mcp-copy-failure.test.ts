/**
 * Regression: the MCP auth copy-URL path must surface a failure flash when
 * both clipboard legs fail, never an unhandled rejection that would route to
 * handleFatal and exit the process.
 */
import { describe, expect, test } from "bun:test";
import { openCommandSurface, type McpEntry } from "./command-surfaces";
import { withTestRenderer } from "./harness";
import { createAppShell } from "./shell/index";
import type { AppShell } from "./shell/internals";
import {
  acceptOverlaySelection,
  closeInsetOverlay,
} from "./shell/overlay-host";
import { moveOverlaySelection } from "./shell/overlay-list";

const entries: readonly McpEntry[] = [
  { name: "notion", state: "needs-auth", authURL: "https://notion.test/auth" },
];

async function withShell(
  fn: (shell: AppShell) => Promise<void> | void,
): Promise<void> {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      });
      try {
        await fn(shell);
      } finally {
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
}

describe("mcp auth copy failure", () => {
  test("both clipboard legs failing flashes copy failed instead of crashing", async () => {
    await withShell(async (shell) => {
      const clip = {
        writeText: () => Promise.reject(new Error("both legs failed")),
      };
      (shell as unknown as { clipboard: typeof clip }).clipboard = clip;
      openCommandSurface(shell, "mcp", {
        notify: () => undefined,
        mcp: { list: () => entries, openAuthURL: () => undefined },
      });
      moveOverlaySelection(shell, 0);
      acceptOverlaySelection(shell);
      await Promise.resolve();
      await Promise.resolve();
      // The rejection must resolve into the writeClipboard failure flash — an
      // unhandled rejection here would take the whole process down.
      expect(shell.statusFlash).toContain("copy failed");
      closeInsetOverlay(shell);
    });
  });

  test("a successful copy flashes that the link was copied", async () => {
    await withShell(async (shell) => {
      const clip = { writeText: () => Promise.resolve() };
      (shell as unknown as { clipboard: typeof clip }).clipboard = clip;
      openCommandSurface(shell, "mcp", {
        notify: () => undefined,
        mcp: { list: () => entries, openAuthURL: () => undefined },
      });
      moveOverlaySelection(shell, 0);
      acceptOverlaySelection(shell);
      await Promise.resolve();
      await Promise.resolve();
      expect(shell.statusFlash).toContain("link copied");
      closeInsetOverlay(shell);
    });
  });
});
