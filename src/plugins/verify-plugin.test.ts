import { describe, test, expect } from "bun:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ToolResult } from "@intx/types/runtime";
import type { ToolHandler } from "@intx/tools-posix";

import { verifyPlugin } from "./verify-plugin.js";
import {
  lineRangeEditCall,
  neverAbort,
  pluginHandler,
} from "./test-helpers.js";
import { withTempDir } from "../testkit/temporary-dirs.js";

// Terminal handlers the middleware verifies against.
const writeCallHandler: ToolHandler = async (call) => {
  const path = String(call.arguments.path ?? "");
  const content = String(call.arguments.content ?? "");
  await writeFile(path, content);
  return { callId: call.id, content: "written" };
};

const substringEditHandler: ToolHandler = async (call) => {
  const path = String(call.arguments.path ?? "");
  const oldStr = String(call.arguments.old_string ?? "");
  const newStr = String(call.arguments.new_string ?? "");
  const content = await readFile(path, "utf8");
  await writeFile(path, content.replace(oldStr, newStr));
  return { callId: call.id, content: "edited" };
};

const lineRangeEditHandler: ToolHandler = async (call) => {
  const path = String(call.arguments.path ?? "");
  const start = Number(call.arguments.start_line);
  const end = Number(call.arguments.end_line);
  const newStr = String(call.arguments.new_string ?? "");
  const content = await readFile(path, "utf8");
  const lines = content.split("\n");
  const before = lines.slice(0, start - 1);
  const after = lines.slice(end);
  const inserted = newStr.split("\n");
  const merged = [...before, ...inserted, ...after].join("\n");
  await writeFile(path, merged.endsWith("\n") ? merged : merged + "\n");
  return { callId: call.id, content: "edited" };
};

// A handler that lands `content` verbatim regardless of the call — the
// stand-in for a bad write/edit that verifyPlugin must catch.
const overwriteHandler =
  (content: string, reply: string): ToolHandler =>
  async (call): Promise<ToolResult> => {
    await writeFile(String(call.arguments.path ?? ""), content);
    return { callId: call.id, content: reply };
  };

const verify = (next: ToolHandler): ToolHandler =>
  pluginHandler(verifyPlugin(), next);

describe("verifyPlugin", () => {
  test("passes when write matches", async () => {
    await withTempDir("verify-test-", async (dir) => {
      const handler = verify(writeCallHandler);
      const path = join(dir, "test.txt");
      const result = await handler(
        {
          id: "call-1",
          name: "write_file",
          arguments: { path, content: "hello world" },
        },
        neverAbort(),
      );
      expect(result.isError).toBeUndefined();
    });
  });

  test("fails when write is truncated", async () => {
    await withTempDir("verify-test-", async (dir) => {
      const handler = verify(overwriteHandler("short", "written"));
      const path = join(dir, "test.txt");
      const result = await handler(
        {
          id: "call-1",
          name: "write_file",
          arguments: { path, content: "hello world" },
        },
        neverAbort(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/content mismatch/);
    });
  });

  test("passes when edit_file matches expected result", async () => {
    await withTempDir("verify-test-", async (dir) => {
      const handler = verify(substringEditHandler);
      const path = join(dir, "test.txt");
      await writeFile(path, "hello world");
      const result = await handler(
        {
          id: "call-1",
          name: "edit_file",
          arguments: { path, old_string: "world", new_string: "universe" },
        },
        neverAbort(),
      );
      expect(result.isError).not.toBe(true);
    });
  });

  test("fails when edit_file produces wrong result", async () => {
    await withTempDir("verify-test-", async (dir) => {
      const handler = verify(overwriteHandler("wrong content", "edited"));
      const path = join(dir, "test.txt");
      await writeFile(path, "hello world");
      const result = await handler(
        {
          id: "call-1",
          name: "edit_file",
          arguments: { path, old_string: "world", new_string: "universe" },
        },
        neverAbort(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/content mismatch after replacement/);
    });
  });

  test("skips verification when edit_file mixes substring and line-range args", async () => {
    await withTempDir("verify-test-", async (dir) => {
      // Mixed-mode is invalid at the parse layer; verify should not treat it as
      // a successful line-range edit even if the underlying write applied one.
      const handler = verify(lineRangeEditHandler);
      const path = join(dir, "mixed.txt");
      await writeFile(path, "a\nb\nc\n");
      const result = await handler(
        {
          id: "call-mixed",
          name: "edit_file",
          arguments: {
            path,
            old_string: "b",
            start_line: 2,
            end_line: 2,
            new_string: "B",
          },
        },
        neverAbort(),
      );
      // Invalid mode short-circuits verification; result is whatever the handler returned.
      expect(result.isError).not.toBe(true);
      expect(result.content).toBe("edited");
    });
  });

  test("passes when edit_file line-range mode matches expected result", async () => {
    await withTempDir("verify-test-", async (dir) => {
      const handler = verify(lineRangeEditHandler);
      const path = join(dir, "range.txt");
      await writeFile(path, "a\nb\nc\n");
      const result = await handler(
        lineRangeEditCall(path, "call-range"),
        neverAbort(),
      );
      expect(result.isError).not.toBe(true);
    });
  });

  test("fails when edit_file line-range produces wrong result", async () => {
    await withTempDir("verify-test-", async (dir) => {
      const handler = verify(overwriteHandler("wrong\n", "edited"));
      const path = join(dir, "range-bad.txt");
      await writeFile(path, "a\nb\n");
      const result = await handler(
        lineRangeEditCall(path, "call-range-bad"),
        neverAbort(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/content mismatch after replacement/);
    });
  });

  test("serializes parallel edit_file on the same path", async () => {
    await withTempDir("verify-test-", async (dir) => {
      const handler = verify(substringEditHandler);
      const path = join(dir, "test.txt");
      await writeFile(path, "aaa bbb ccc");

      const [r1, r2] = await Promise.all([
        handler(
          {
            id: "call-1",
            name: "edit_file",
            arguments: { path, old_string: "aaa", new_string: "AAA" },
          },
          neverAbort(),
        ),
        handler(
          {
            id: "call-2",
            name: "edit_file",
            arguments: { path, old_string: "bbb", new_string: "BBB" },
          },
          neverAbort(),
        ),
      ]);

      expect(r1.isError).not.toBe(true);
      expect(r2.isError).not.toBe(true);
      const final = await readFile(path, "utf8");
      expect(final).toBe("AAA BBB ccc");
    });
  });

  test("successful edit_file result includes the changed region", async () => {
    await withTempDir("verify-test-", async (dir) => {
      const handler = verify(substringEditHandler);
      const path = join(dir, "diff.txt");
      await writeFile(path, "line1\nworld\nline3\n");
      const result = await handler(
        {
          id: "call-diff",
          name: "edit_file",
          arguments: { path, old_string: "world", new_string: "universe" },
        },
        neverAbort(),
      );

      expect(result.isError).not.toBe(true);
      expect(result.content).toContain("-world");
      expect(result.content).toContain("+universe");
    });
  });

  test("successful write_file result includes a bounded diff for a whole-file rewrite", async () => {
    await withTempDir("verify-test-", async (dir) => {
      const handler = verify(writeCallHandler);
      const path = join(dir, "rewrite.txt");
      await writeFile(path, "old content\n".repeat(2000));
      const newContent = "new content\n".repeat(2000);
      const result = await handler(
        {
          id: "call-rewrite",
          name: "write_file",
          arguments: { path, content: newContent },
        },
        neverAbort(),
      );

      expect(result.isError).not.toBe(true);
      expect(result.content).toContain("truncated");
      expect(String(result.content).length).toBeLessThan(6_000);
    });
  });

  test("write_file creating a new file shows the added content, not an error", async () => {
    await withTempDir("verify-test-", async (dir) => {
      const handler = verify(writeCallHandler);
      const path = join(dir, "new.txt");
      const result = await handler(
        {
          id: "call-new",
          name: "write_file",
          arguments: { path, content: "brand new\n" },
        },
        neverAbort(),
      );

      expect(result.isError).not.toBe(true);
      expect(result.content).toContain("+brand new");
    });
  });
});
