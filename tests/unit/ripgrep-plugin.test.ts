import { test, expect } from "bun:test";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { ripgrepPlugin } from "../../src/plugins/ripgrep-plugin.js";

const cwd = process.cwd();
const fallback = async (): Promise<ToolResult> => ({ callId: "c", content: "FALLBACK", isError: true });

function run(call: ToolCall): Promise<ToolResult> {
  const handler = ripgrepPlugin(cwd).middleware!(fallback);
  return handler(call, new AbortController().signal);
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
