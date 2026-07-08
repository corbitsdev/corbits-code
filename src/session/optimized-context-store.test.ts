import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationTurn } from "@intx/types/runtime";
import { createOptimizedContextStore } from "./optimized-context-store.js";
import { segmentFileName, listSegmentFiles } from "./incremental-jsonl.js";

const TURNS_FILE = "turns.jsonl";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opt-store-"));
}

function turn(text: string): ConversationTurn {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function jsonl(turns: ConversationTurn[]): string {
  return turns.map((t) => JSON.stringify(t)).join("\n") + "\n";
}

describe("createOptimizedContextStore load", () => {
  test("resumes turns spread across multiple segments in order", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);

    fs.writeFileSync(path.join(dir, TURNS_FILE), jsonl([turn("a"), turn("b")]));
    fs.writeFileSync(path.join(dir, segmentFileName(TURNS_FILE, 1)), jsonl([turn("c")]));
    fs.writeFileSync(path.join(dir, segmentFileName(TURNS_FILE, 2)), jsonl([turn("d"), turn("e")]));

    const loaded = await store.load();
    expect(loaded.turns.map((t) => (t.content[0] as { text: string }).text)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  test("reads a legacy monolithic turns.jsonl with no segments", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    fs.writeFileSync(path.join(dir, TURNS_FILE), jsonl([turn("only")]));

    const loaded = await store.load();
    expect(loaded.turns).toHaveLength(1);
    expect((loaded.turns[0]!.content[0] as { text: string }).text).toBe("only");
  });

  test("recovers from a torn final line in the active segment", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);

    fs.writeFileSync(path.join(dir, TURNS_FILE), jsonl([turn("a")]));
    const seg1 = path.join(dir, segmentFileName(TURNS_FILE, 1));
    fs.writeFileSync(seg1, jsonl([turn("b")]) + '{"role":"user","content":[{"type":"te');

    const loaded = await store.load();
    expect(loaded.turns.map((t) => (t.content[0] as { text: string }).text)).toEqual(["a", "b"]);
  });
});

describe("createOptimizedContextStore checkpoint", () => {
  test("rolls segments, stages only what changed, and reloads across a commit", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);

    const turns: ConversationTurn[] = [];
    const big = "x".repeat(20_000);
    const total = 18;
    for (let i = 0; i < total; i++) {
      turns.push(turn(`${i}-${big}`));
      await store.writeTurns([...turns]);
      if (i === 9 || i === total - 1) {
        await store.writeMetadata({
          pendingOperations: [],
          tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        });
        await store.commit({ message: `turn ${i}` });
      }
    }

    expect((await listSegmentFiles(dir, TURNS_FILE)).length).toBeGreaterThan(1);

    const reloaded = await createOptimizedContextStore(dir);
    const loaded = await reloaded.load();
    expect(loaded.turns).toHaveLength(total);

    const head = (await store.log(1))[0]!;
    const atHead = await store.readAt(head.hash);
    expect(atHead).toHaveLength(total);
  }, 20_000);
});
