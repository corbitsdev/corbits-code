import { describe, test, expect } from "bun:test";

import { pathEscapePlugin } from "../../src/plugins/path-escape-plugin.js";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: "test-call",
    name,
    arguments: args,
  };
}

const nextHandler = async (call: ToolCall): Promise<ToolResult> => ({
  callId: call.id,
  content: "ok",
});

describe("pathEscapePlugin", () => {
  test("allows paths inside cwd", async () => {
    const plugin = pathEscapePlugin("/project");
    const handler = plugin.middleware
      ? plugin.middleware(nextHandler)
      : nextHandler;
    const result = await handler(
      makeCall("read_file", { path: "src/index.ts" }),
      new AbortController().signal,
    );
    expect(result.isError).toBeUndefined();
  });

  test("blocks paths that escape cwd", async () => {
    const plugin = pathEscapePlugin("/project");
    const handler = plugin.middleware
      ? plugin.middleware(nextHandler)
      : nextHandler;
    const result = await handler(
      makeCall("read_file", { path: "../secret.txt" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes working directory/);
  });

  test("blocks absolute paths outside cwd", async () => {
    const plugin = pathEscapePlugin("/project");
    const handler = plugin.middleware
      ? plugin.middleware(nextHandler)
      : nextHandler;
    const result = await handler(
      makeCall("read_file", { path: "/etc/passwd" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes working directory/);
  });
});
