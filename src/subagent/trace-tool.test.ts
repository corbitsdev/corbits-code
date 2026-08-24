import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createReadAgentTraceTool } from "./trace-tool.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trace-tool-"));
}

function writeTurns(dir: string, turns: unknown[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "turns.jsonl"),
    turns.map((t) => JSON.stringify(t)).join("\n") + (turns.length > 0 ? "\n" : ""),
  );
}

describe("createReadAgentTraceTool", () => {
  test("rejects a missing target with a clean, non-throwing error result", async () => {
    const root = tempDir();
    const tool = createReadAgentTraceTool(() => root);
    if (tool.kind !== "string") throw new Error("expected string tool");
    const text = await tool.handler({ target: "ghost" }, new AbortController().signal);
    expect(text).toContain("No on-disk trace found");
  });

  test("rejects a missing required arg without throwing", async () => {
    const root = tempDir();
    const tool = createReadAgentTraceTool(() => root);
    if (tool.kind !== "string") throw new Error("expected string tool");
    const text = await tool.handler({}, new AbortController().signal);
    expect(text).toContain("Error");
  });

  test("formats turns, tool calls, and truncation info for a real worker", async () => {
    const root = tempDir();
    writeTurns(path.join(root, "subagents", "worker-1"), [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    const tool = createReadAgentTraceTool(() => root);
    if (tool.kind !== "string") throw new Error("expected string tool");
    const text = await tool.handler({ target: "worker-1" }, new AbortController().signal);
    expect(text).toContain("worker-1");
    expect(text).toContain("hello");
  });
});
