import { describe, test, expect } from "bun:test";

import { pathEscapePlugin } from "./path-escape-plugin.js";
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
    expect(result.isError).not.toBe(true);
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

  test("allows cwd path itself", async () => {
    const plugin = pathEscapePlugin("/project");
    const handler = plugin.middleware
      ? plugin.middleware(nextHandler)
      : nextHandler;
    const result = await handler(
      makeCall("read_file", { path: "." }),
      new AbortController().signal,
    );
    expect(result.isError).not.toBe(true);
  });

  test("blocks escape via cwd key", async () => {
    const plugin = pathEscapePlugin("/project");
    const handler = plugin.middleware
      ? plugin.middleware(nextHandler)
      : nextHandler;
    const result = await handler(
      makeCall("run_shell", { cwd: "../secret" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes working directory/);
  });

  test("blocks escape via directory key", async () => {
    const plugin = pathEscapePlugin("/project");
    const handler = plugin.middleware
      ? plugin.middleware(nextHandler)
      : nextHandler;
    const result = await handler(
      makeCall("list_dir", { directory: "/etc" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes working directory/);
  });

  test("blocks escape via source key", async () => {
    const plugin = pathEscapePlugin("/project");
    const handler = plugin.middleware
      ? plugin.middleware(nextHandler)
      : nextHandler;
    const result = await handler(
      makeCall("copy", { source: "/etc/passwd" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes working directory/);
  });

  test("blocks escape via filename key", async () => {
    const plugin = pathEscapePlugin("/project");
    const handler = plugin.middleware
      ? plugin.middleware(nextHandler)
      : nextHandler;
    const result = await handler(
      makeCall("write_file", { filename: "../secret.txt" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes working directory/);
  });
});
