import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AgentTraceNotFoundError,
  findAgentTraceDir,
  listUniqueSubdirs,
  readAgentTrace,
  MAX_TRACE_ENTRY_LIMIT,
  MAX_TRACE_TOTAL_CHARS,
  MAX_TRACE_TURN_WINDOW,
} from "./trace-reader.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trace-reader-"));
}

function writeTurns(dir: string, turns: unknown[]): void {
  fs.mkdirSync(dir, { recursive: true });
  const text = turns.map((t) => JSON.stringify(t)).join("\n") + (turns.length > 0 ? "\n" : "");
  fs.writeFileSync(path.join(dir, "turns.jsonl"), text);
}

describe("listUniqueSubdirs", () => {
  test("a directory containing latest plus its target enumerates the session exactly once", async () => {
    const root = tempDir();
    const real = path.join(root, "01234567-89ab-7def-8123-456789abcdef");
    fs.mkdirSync(real);
    fs.symlinkSync(path.basename(real), path.join(root, "latest"));

    const entries = await listUniqueSubdirs(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe(fs.realpathSync(real));
  });

  test("two distinct real directories are both listed", async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, "a"));
    fs.mkdirSync(path.join(root, "b"));
    const entries = await listUniqueSubdirs(root);
    expect(entries).toHaveLength(2);
  });

  test("a broken symlink is skipped, not thrown", async () => {
    const root = tempDir();
    fs.symlinkSync(path.join(root, "does-not-exist"), path.join(root, "dangling"));
    const entries = await listUniqueSubdirs(root);
    expect(entries).toHaveLength(0);
  });

  test("missing directory returns empty rather than throwing", async () => {
    const entries = await listUniqueSubdirs(path.join(tempDir(), "nope"));
    expect(entries).toHaveLength(0);
  });
});

describe("findAgentTraceDir", () => {
  test("finds a direct child under root/subagents", async () => {
    const root = tempDir();
    const childDir = path.join(root, "subagents", "child-1");
    writeTurns(childDir, []);
    const found = await findAgentTraceDir(root, "child-1");
    expect(found).toBe(fs.realpathSync(childDir));
  });

  test("finds a nested descendant several levels deep", async () => {
    const root = tempDir();
    const grandchildDir = path.join(root, "subagents", "child-1", "subagents", "grandchild-1");
    writeTurns(grandchildDir, []);
    const found = await findAgentTraceDir(root, "grandchild-1");
    expect(found).toBe(fs.realpathSync(grandchildDir));
  });

  test("returns null for an unknown id", async () => {
    const root = tempDir();
    writeTurns(path.join(root, "subagents", "child-1"), []);
    const found = await findAgentTraceDir(root, "does-not-exist");
    expect(found).toBeNull();
  });

  test("is not confused by a latest symlink alongside the real worker dir", async () => {
    const root = tempDir();
    const childDir = path.join(root, "subagents", "child-1");
    writeTurns(childDir, []);
    fs.symlinkSync("child-1", path.join(root, "subagents", "latest"));
    const found = await findAgentTraceDir(root, "child-1");
    expect(found).toBe(fs.realpathSync(childDir));
  });
});

describe("readAgentTrace", () => {
  test("throws a clean error for a missing target", async () => {
    const root = tempDir();
    await expect(readAgentTrace(root, "ghost")).rejects.toBeInstanceOf(AgentTraceNotFoundError);
  });

  test("reads turns, tool calls, and tool errors", async () => {
    const root = tempDir();
    const childDir = path.join(root, "subagents", "worker-1");
    writeTurns(childDir, [
      { role: "user", content: [{ type: "text", text: "do the thing" }] },
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "call-1", name: "run_shell", arguments: { cmd: "ls" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            callId: "call-1",
            content: [{ type: "text", text: "boom" }],
            isError: true,
          },
        ],
      },
    ]);

    const result = await readAgentTrace(root, "worker-1");
    expect(result.totalTurns).toBe(3);
    expect(result.entries.map((e) => e.kind)).toEqual(["text", "tool_call", "error"]);
    expect(result.entries[2]!.isError).toBe(true);
    expect(result.omitted).toBeNull();
  });

  test("skips a malformed trailing line instead of throwing", async () => {
    const root = tempDir();
    const childDir = path.join(root, "subagents", "worker-1");
    fs.mkdirSync(childDir, { recursive: true });
    const good = JSON.stringify({ role: "user", content: [{ type: "text", text: "hi" }] });
    fs.writeFileSync(path.join(childDir, "turns.jsonl"), `${good}\n{"role":"assistant","cont`);

    const result = await readAgentTrace(root, "worker-1");
    expect(result.totalTurns).toBe(1);
    expect(result.parseWarnings).toBe(1);
    expect(result.entries).toHaveLength(1);
  });

  test("bounds the entry count to the requested limit and reports omission", async () => {
    const root = tempDir();
    const childDir = path.join(root, "subagents", "worker-1");
    const turns = Array.from({ length: 5 }, (_, i) => ({
      role: "assistant",
      content: [{ type: "text", text: `turn ${i}` }],
    }));
    writeTurns(childDir, turns);

    const result = await readAgentTrace(root, "worker-1", { limit: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.entriesTruncated).toBe(true);
    expect(result.omitted).not.toBeNull();
    expect(result.omitted!.hint.length).toBeGreaterThan(0);
  });

  test("never exceeds the total-output character cap regardless of entry/window caps", async () => {
    const root = tempDir();
    const childDir = path.join(root, "subagents", "worker-1");
    const turns = Array.from({ length: 600 }, (_, i) => ({
      role: "assistant",
      content: [{ type: "text", text: `turn ${i} `.repeat(1000) }], // ~5,000 chars each
    }));
    writeTurns(childDir, turns);

    const result = await readAgentTrace(root, "worker-1", {
      fromTurn: 0,
      toTurn: 600,
      limit: MAX_TRACE_ENTRY_LIMIT,
    });
    const totalChars = result.entries.reduce((sum, e) => sum + e.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(MAX_TRACE_TOTAL_CHARS);
    expect(result.entriesTruncated).toBe(true);
    expect(result.omitted).not.toBeNull();
    expect(result.omitted!.reason).toContain("total output cap");
  });

  test("never exceeds the hard entry-limit cap regardless of requested limit", async () => {
    const root = tempDir();
    const childDir = path.join(root, "subagents", "worker-1");
    const turns = Array.from({ length: 10 }, (_, i) => ({
      role: "assistant",
      content: [{ type: "text", text: `turn ${i}` }],
    }));
    writeTurns(childDir, turns);

    const result = await readAgentTrace(root, "worker-1", { limit: 1_000_000 });
    expect(result.entries.length).toBeLessThanOrEqual(MAX_TRACE_ENTRY_LIMIT);
  });

  test("never exceeds the hard turn-window cap regardless of requested range", async () => {
    const root = tempDir();
    const childDir = path.join(root, "subagents", "worker-1");
    const turns = Array.from({ length: 500 }, (_, i) => ({
      role: "assistant",
      content: [{ type: "text", text: `turn ${i}` }],
    }));
    writeTurns(childDir, turns);

    const result = await readAgentTrace(root, "worker-1", {
      fromTurn: 0,
      toTurn: 500,
      limit: MAX_TRACE_ENTRY_LIMIT,
    });
    expect(result.toTurn - result.fromTurn).toBeLessThanOrEqual(MAX_TRACE_TURN_WINDOW);
  });

  test("filters entries by kind", async () => {
    const root = tempDir();
    const childDir = path.join(root, "subagents", "worker-1");
    writeTurns(childDir, [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "hello" },
        ],
      },
    ]);

    const result = await readAgentTrace(root, "worker-1", { kinds: ["text"] });
    expect(result.entries.map((e) => e.kind)).toEqual(["text"]);
  });

  test("truncates an oversized entry body and marks it truncated", async () => {
    const root = tempDir();
    const childDir = path.join(root, "subagents", "worker-1");
    writeTurns(childDir, [
      { role: "assistant", content: [{ type: "text", text: "x".repeat(10_000) }] },
    ]);

    const result = await readAgentTrace(root, "worker-1");
    expect(result.entries[0]!.truncated).toBe(true);
    expect(result.entries[0]!.content.length).toBeLessThan(10_000);
  });

  test("a partially written trace (worker still running) reads what exists so far", async () => {
    const root = tempDir();
    const childDir = path.join(root, "subagents", "worker-1");
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(
      path.join(childDir, "turns.jsonl"),
      `${JSON.stringify({ role: "user", content: [{ type: "text", text: "go" }] })}\n`,
    );

    const result = await readAgentTrace(root, "worker-1");
    expect(result.totalTurns).toBe(1);
    expect(result.entries).toHaveLength(1);
  });
});
