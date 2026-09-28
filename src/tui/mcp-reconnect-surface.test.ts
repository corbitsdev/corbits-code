/**
 * The MCP surface keeps a reconnecting row distinct from connecting: the
 * label carries the redial attempt and the retained tool count, and Enter
 * single-dials via retryServer instead of waiting for backoff.
 */
import { describe, expect, test } from "bun:test";
import {
  mcpRowLabel,
  openCommandSurface,
  type McpEntry,
} from "./command-surfaces";
import {
  acceptOverlaySelection,
  closeInsetOverlay,
} from "./shell/overlay-host";
import { moveOverlaySelection } from "./shell/overlay-list";
import { withAppShell } from "./test-helpers";

const entries: readonly McpEntry[] = [
  {
    name: "acme",
    state: "reconnecting",
    toolCount: 2,
    attempt: 3,
    error: "transport closed unexpectedly",
  },
];

describe("mcp reconnecting surface", () => {
  test("the row label shows the attempt and the retained tool count", () => {
    const entry = entries[0];
    if (!entry) {
      throw new Error("expected reconnecting entry");
    }
    expect(mcpRowLabel(entry)).toBe(
      "acme — reconnecting · attempt 3 · 2 tools",
    );
  });

  test("Enter on a reconnecting row retries that server without a second row", async () => {
    await withAppShell(async (shell) => {
      const retried: string[] = [];
      const notices: string[] = [];
      openCommandSurface(shell, "mcp", {
        notify: (message: string) => notices.push(message),
        mcp: {
          list: () => entries,
          openAuthURL: () => undefined,
          retryServer: async (name: string) => {
            retried.push(name);
            return { ok: true, message: `Retrying ${name}; connecting now.` };
          },
        },
      });
      moveOverlaySelection(shell, 0);
      acceptOverlaySelection(shell);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(retried).toEqual(["acme"]);
      expect(notices.join("\n")).toContain("Retrying acme");
      closeInsetOverlay(shell);
    });
  });
});
