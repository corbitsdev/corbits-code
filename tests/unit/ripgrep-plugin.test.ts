import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { ripgrepPlugin } from "../../src/plugins/ripgrep-plugin.js";

const cwd = process.cwd();
const fallback = async (): Promise<ToolResult> => ({ callId: "c", content: "FALLBACK", isError: true });

function run(
  call: ToolCall,
  limits: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<ToolResult> {
  const handler = ripgrepPlugin(cwd, limits).middleware!(fallback);
  return handler(call, new AbortController().signal);
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ripgrep-plugin-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("grep routes through ripgrep and returns matches", async () => {
  const result = await run({
    id: "c",
    name: "grep",
    arguments: { pattern: "ripgrepPlugin", path: "src/plugins" },
  });
  expect(result.content).not.toBe("FALLBACK");
  expect(result.isError).toBeUndefined();
  expect(result.content).toContain("ripgrepPlugin");
});

test("grep reports no matches without falling back", async () => {
  const result = await run({
    id: "c",
    name: "grep",
    arguments: { pattern: "zzz_no_such_symbol_zzz", path: "src/plugins" },
  });
  expect(result.content).toContain("no matches");
  expect(result.isError).toBeUndefined();
});

test("search_files routes through ripgrep and lists files", async () => {
  const result = await run({
    id: "c",
    name: "search_files",
    arguments: { pattern: "ripgrep-plugin.ts", path: "src" },
  });
  expect(result.content).not.toBe("FALLBACK");
  expect(result.content).toContain("ripgrep-plugin.ts");
});

test("unrelated tools fall through to the next handler", async () => {
  const result = await run({ id: "c", name: "read_file", arguments: { path: "x" } });
  expect(result.content).toBe("FALLBACK");
});

test("grep returns partial matches when the output byte cap is hit", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "big.txt"), "match line here\n".repeat(5000));
    const result = await run(
      {
        id: "c",
        name: "grep",
        arguments: { pattern: "match", path: dir, max_results: 5000 },
      },
      { maxOutputBytes: 200 },
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("match line here");
    expect(result.content).toContain("exceeded 200 bytes");
    expect(result.content).toContain("narrow path/glob or pattern");
  });
});

test("grep returns partial matches when the timeout fires", async () => {
  const result = await run(
    { id: "c", name: "grep", arguments: { pattern: "e", path: "src" } },
    { timeoutMs: 1 },
  );
  expect(result.isError).toBeUndefined();
  expect(result.content).toContain("timed out");
  expect(result.content).toContain("narrow path/glob");
});
