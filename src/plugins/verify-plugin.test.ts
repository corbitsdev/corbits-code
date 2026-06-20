import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { verifyPlugin } from "./verify-plugin.js";
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
      expect(result.content).toMatch(/content mismatch/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails when write has same length but different content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verify-test-"));
    try {
      const plugin = verifyPlugin();
      const badHandler = async (call: ToolCall): Promise<ToolResult> => {
        const path = String(call.arguments.path ?? "");
        await writeFile(path, "XXXX XXXXXX"); // 11 chars, same length as "hello world"
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
      expect(result.content).toMatch(/content mismatch/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("passes when edit_file matches expected result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verify-test-"));
    try {
      const plugin = verifyPlugin();
      const editHandler = async (call: ToolCall): Promise<ToolResult> => {
        const path = String(call.arguments.path ?? "");
        const oldStr = String(call.arguments.old_string ?? "");
        const newStr = String(call.arguments.new_string ?? "");
        const content = await readFile(path, "utf8");
        const updated = content.replace(oldStr, newStr);
        await writeFile(path, updated);
        return { callId: call.id, content: "edited" };
      };
      const handler = plugin.middleware
        ? plugin.middleware(editHandler)
        : editHandler;

      const path = join(dir, "test.txt");
      await writeFile(path, "hello world");
      const result = await handler(
        {
          id: "call-1",
          name: "edit_file",
          arguments: { path, old_string: "world", new_string: "universe" },
        },
        new AbortController().signal,
      );
      expect(result.isError).not.toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails when edit_file produces wrong result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verify-test-"));
    try {
      const plugin = verifyPlugin();
      const badHandler = async (call: ToolCall): Promise<ToolResult> => {
        const path = String(call.arguments.path ?? "");
        await writeFile(path, "wrong content");
        return { callId: call.id, content: "edited" };
      };
      const handler = plugin.middleware
        ? plugin.middleware(badHandler)
        : badHandler;

      const path = join(dir, "test.txt");
      await writeFile(path, "hello world");
      const result = await handler(
        {
          id: "call-1",
          name: "edit_file",
          arguments: { path, old_string: "world", new_string: "universe" },
        },
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/content mismatch after replacement/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("serializes parallel edit_file on the same path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verify-test-"));
    try {
      const plugin = verifyPlugin();
      const editHandler = async (call: ToolCall): Promise<ToolResult> => {
        const path = String(call.arguments.path ?? "");
        const oldStr = String(call.arguments.old_string ?? "");
        const newStr = String(call.arguments.new_string ?? "");
        const content = await readFile(path, "utf8");
        const updated = content.replace(oldStr, newStr);
        await writeFile(path, updated);
        return { callId: call.id, content: "edited" };
      };
      const handler = plugin.middleware
        ? plugin.middleware(editHandler)
        : editHandler;

      const path = join(dir, "test.txt");
      await writeFile(path, "aaa bbb ccc");

      const [r1, r2] = await Promise.all([
        handler(
          {
            id: "call-1",
            name: "edit_file",
            arguments: { path, old_string: "aaa", new_string: "AAA" },
          },
          new AbortController().signal,
        ),
        handler(
          {
            id: "call-2",
            name: "edit_file",
            arguments: { path, old_string: "bbb", new_string: "BBB" },
          },
          new AbortController().signal,
        ),
      ]);

      expect(r1.isError).not.toBe(true);
      expect(r2.isError).not.toBe(true);
      const final = await readFile(path, "utf8");
      expect(final).toBe("AAA BBB ccc");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
