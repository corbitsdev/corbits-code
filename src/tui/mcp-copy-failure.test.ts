/**
 * Regression: the MCP auth copy-URL path must surface a failure flash when
 * both clipboard legs fail, never an unhandled rejection that would route to
 * handleFatal and exit the process.
 */
import { describe, expect, test } from "bun:test";
import { openCommandSurface, type McpEntry } from "./command-surfaces";
import {
  acceptOverlaySelection,
  closeInsetOverlay,
} from "./shell/overlay-host";
import { moveOverlaySelection } from "./shell/overlay-list";
import { withAppShell } from "./test-helpers";

const entries: readonly McpEntry[] = [
  { name: "notion", state: "needs-auth", authURL: "https://notion.test/auth" },
];

describe("mcp auth copy failure", () => {
  test("both clipboard legs failing flashes copy failed instead of crashing", async () => {
    await withAppShell(async (shell) => {
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
      // The rejection must resolve into a status flash — an unhandled
      // rejection here would take the whole process down.
      expect(shell.statusFlash).toBeTruthy();
      closeInsetOverlay(shell);
    });
  });
});
