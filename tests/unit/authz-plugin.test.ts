import { describe, test, expect } from "bun:test";

import { authzPlugin } from "../../src/plugins/authz-plugin.js";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

function makeShellCall(command: string): ToolCall {
  return {
    id: "test-call",
    name: "run_shell",
    arguments: { command },
  };
}

const nextHandler = async (call: ToolCall): Promise<ToolResult> => ({
  callId: call.id,
  content: "ok",
});

describe("authzPlugin", () => {
  test("allows safe commands", async () => {
    const plugin = authzPlugin();
    const handler = plugin.middleware
      ? plugin.middleware(nextHandler)
      : nextHandler;
    const result = await handler(
      makeShellCall("bun test"),
      new AbortController().signal,
    );
    expect(result.isError).toBeUndefined();
  });

  test("blocks rm -rf /", async () => {
    const plugin = authzPlugin();
    const handler = plugin.middleware
      ? plugin.middleware(nextHandler)
      : nextHandler;
    const result = await handler(
      makeShellCall("rm -rf /"),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Destructive command blocked/);
  });

  test("blocks dd if=", async () => {
    const plugin = authzPlugin();
    const handler = plugin.middleware
      ? plugin.middleware(nextHandler)
      : nextHandler;
    const result = await handler(
      makeShellCall("dd if=/dev/zero of=/dev/sda"),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Destructive command blocked/);
  });
});
