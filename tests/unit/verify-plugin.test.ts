import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { verifyPlugin } from "../../src/plugins/verify-plugin.js";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

async function makeNextHandler(call: ToolCall): Promise<ToolResult> {
  const path = String(call.arguments.path ?? "");
  const content = String(call.arguments.content ?? "");
  await writeFile(path, content);
  return { callId: call.id, content: "written" };
}

describe("verifyPlugin", () => {
  test("passes when write matches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verify-test-"));
    try {
      const plugin = verifyPlugin();
      const handler = plugin.middleware
        ? plugin.middleware(makeNextHandler)
        : makeNextHandler;

      const path = join(dir, "test.txt");
      const result = await handler(
        {
          id: "call-1",
          name: "write_file",
          arguments: { path, content: "hello world" },
        },
        new AbortController().signal,
      );
      expect(result.isError).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails when write is truncated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verify-test-"));
    try {
      const plugin = verifyPlugin();
      const badHandler = async (call: ToolCall): Promise<ToolResult> => {
        const path = String(call.arguments.path ?? "");
        await writeFile(path, "short");
        return { callId: call.id, content: "written" };
      };
      const handler = plugin.middleware
        ? plugin.middleware(badHandler)
        : badHandler;

      const path = join(dir, "test.txt");
      const result = await handler(
        {
          id: "call-1",
          name: "write_file",
          arguments: { path, content: "hello world" },
        },
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/length mismatch/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
