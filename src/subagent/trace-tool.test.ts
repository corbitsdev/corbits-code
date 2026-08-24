import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createReadAgentTraceTool } from "./trace-tool.js";
import type { FleetNode } from "./authority.js";

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

  describe("descendant-only scoping (two sibling subtrees under one flat root)", () => {
    // Every worker at every nesting depth lands under the same root
    // subagents/ dir (see run.ts), so on disk workerA1 and workerY are
    // indistinguishable siblings. Authority comes entirely from the fleet
    // node list (parentSessionId chain), not from directory structure.
    const nodes: FleetNode[] = [
      { id: "orchA" },
      { id: "workerA1", parentSessionId: "orchA" },
      { id: "orchB" },
      { id: "workerY", parentSessionId: "orchB" },
    ];

    function setUpRoot(): string {
      const root = tempDir();
      writeTurns(path.join(root, "subagents", "workerA1"), [
        { role: "assistant", content: [{ type: "text", text: "from A1" }] },
      ]);
      writeTurns(path.join(root, "subagents", "workerY"), [
        { role: "assistant", content: [{ type: "text", text: "from Y" }] },
      ]);
      return root;
    }

    test("orchestratorA can read its own descendant workerA1", async () => {
      const root = setUpRoot();
      const tool = createReadAgentTraceTool(() => root, {
        actorId: "orchA",
        tier: "nested-orchestrator",
        getNodes: () => nodes,
      });
      if (tool.kind !== "string") throw new Error("expected string tool");
      const text = await tool.handler({ target: "workerA1" }, new AbortController().signal);
      expect(text).toContain("from A1");
    });

    test("orchestratorA cannot read workerY, a sibling subtree's worker", async () => {
      const root = setUpRoot();
      const tool = createReadAgentTraceTool(() => root, {
        actorId: "orchA",
        tier: "nested-orchestrator",
        getNodes: () => nodes,
      });
      if (tool.kind !== "string") throw new Error("expected string tool");
      const text = await tool.handler({ target: "workerY" }, new AbortController().signal);
      expect(text).toContain("Error:");
      expect(text).not.toContain("from Y");
    });

    test("an actor with no resolvable session id is denied entirely", async () => {
      const root = setUpRoot();
      const tool = createReadAgentTraceTool(() => root, {
        actorId: undefined,
        tier: "nested-orchestrator",
        getNodes: () => nodes,
      });
      if (tool.kind !== "string") throw new Error("expected string tool");
      const text = await tool.handler({ target: "workerA1" }, new AbortController().signal);
      expect(text).toContain("Error:");
      expect(text).not.toContain("from A1");
    });

    test("Tier 1 (no authority context) can read any worker", async () => {
      const root = setUpRoot();
      const tool = createReadAgentTraceTool(() => root);
      if (tool.kind !== "string") throw new Error("expected string tool");
      const text = await tool.handler({ target: "workerY" }, new AbortController().signal);
      expect(text).toContain("from Y");
    });
  });
});
