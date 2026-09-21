import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Compactor,
  ConversationTurn,
  StrategyContext,
} from "@intx/types/runtime";
import { createOptimizedContextStore } from "../../src/session/optimized-context-store.js";
import {
  createCompactionArchive,
  wrapCompactorWithCompletenessGate,
} from "../../src/session/compaction-archive.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "compact-atomic-"));
}

function turn(text: string): ConversationTurn {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function texts(turns: ConversationTurn[]): string[] {
  return turns.map((t) => (t.content[0] as { text: string }).text);
}

const EMPTY_META = {
  pendingOperations: [],
  tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
};

const ctx = { trigger: "test" } as unknown as StrategyContext;

function truncatingCompactor(): Compactor {
  return {
    name: "pruning-compactor",
    version: "1",
    async apply(_turns) {
      return {
        output: [turn("[Compacted prior context]"), turn("kept-tail")],
        blobs: [
          {
            key: "stats",
            bytes: new TextEncoder().encode("stats"),
            contentType: "text/plain",
          },
        ],
        record: {
          strategy: "pruning-compactor",
          version: "1",
          parameters: {},
          reason: "compact",
          decisions: {},
        },
      };
    },
  };
}

describe("compaction atomicity", () => {
  test("worker rewrite is atomic without an evidence archive", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    await store.writeTurns([turn("w1"), turn("w2"), turn("w3")]);
    await store.writeMetadata(EMPTY_META);
    await store.commit({ message: "worker-old" });

    await store.writeTurns([turn("[Compacted prior context]"), turn("w3")]);
    expect(texts((await store.load()).turns)).toEqual(["w1", "w2", "w3"]);

    const interrupted = await createOptimizedContextStore(dir);
    expect(texts((await interrupted.load()).turns)).toEqual(["w1", "w2", "w3"]);

    await store.commit({ message: "worker-new" });
    expect(texts((await store.load()).turns)).toEqual([
      "[Compacted prior context]",
      "w3",
    ]);
  });

  test("primary incomplete certifyRange refuses destructive compact", async () => {
    const dir = tempDir();
    const blobs = new Map<string, Uint8Array>();
    const archive = createCompactionArchive({
      sessionId: "primary",
      contextDir: dir,
      writeBlob: async (key, bytes) => {
        blobs.set(key, bytes);
      },
      readBlob: async (key) => {
        const hit = blobs.get(key);
        if (hit === undefined) throw new Error(`missing ${key}`);
        return hit;
      },
    });
    const wrapped = wrapCompactorWithCompletenessGate(
      truncatingCompactor(),
      archive,
    );
    const history = [
      turn("fact-a"),
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_call" as const,
            id: "c1",
            name: "read_file",
            arguments: { path: "x" },
          },
        ],
        timestamp: 2,
      },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            callId: "c1",
            content: [{ type: "text" as const, text: "body" }],
          },
        ],
        timestamp: 3,
      },
    ];
    const result = await wrapped.apply(history, ctx);
    expect(result.output).toBe(history);
    expect(result.blobs).toBeUndefined();
    expect(result.record.reason).toBe("incomplete-evidence-archive");
  });

  test("adopted handoff is recorded so the next fold can drop the spine", async () => {
    const dir = tempDir();
    const blobs = new Map<string, Uint8Array>();
    const archive = createCompactionArchive({
      sessionId: "primary",
      contextDir: dir,
      writeBlob: async (key, bytes) => {
        blobs.set(key, bytes);
      },
      readBlob: async (key) => {
        const hit = blobs.get(key);
        if (hit === undefined) throw new Error(`missing ${key}`);
        return hit;
      },
    });
    const foldingCompactor = (
      spine: string,
      keep: ConversationTurn[],
    ): Compactor => ({
      name: "pruning-compactor",
      version: "1",
      async apply(_turns) {
        return {
          output: [turn(spine), ...keep],
          record: {
            strategy: "pruning-compactor",
            version: "1",
            parameters: {},
            reason: "compact",
            decisions: {},
          },
        };
      },
    });
    const history1 = [turn("fact-a"), turn("fact-b")];
    await archive.recordAuthorizedPayload({
      kind: "user_message",
      payload: "fact-a",
    });
    await archive.recordAuthorizedPayload({
      kind: "user_message",
      payload: "fact-b",
    });

    const first = wrapCompactorWithCompletenessGate(
      foldingCompactor("[Compacted prior context] goal-line-1", [
        turn("fact-b"),
      ]),
      archive,
    );
    const adopted1 = await first.apply(history1, ctx);
    expect(adopted1.record.reason).toBe("compact");

    // The new spine never passes through inbound admission, so adoption must
    // leave it in the archive — otherwise the next fold rejects it as
    // uncovered (a repaired spine is never echoed verbatim).
    const handoffs = (await archive.listOccurrences()).filter(
      (occurrence) => occurrence.provenance === "compaction-handoff",
    );
    expect(handoffs).toHaveLength(1);

    await archive.recordAuthorizedPayload({
      kind: "user_message",
      payload: "fact-c",
    });
    const history2 = [...adopted1.output, turn("fact-c")];
    const second = wrapCompactorWithCompletenessGate(
      foldingCompactor("[Compacted prior context] goal-line-2", [
        turn("fact-c"),
      ]),
      archive,
    );
    const adopted2 = await second.apply(history2, ctx);
    expect(adopted2.record.reason).toBe("compact");
    expect(texts(adopted2.output)).toEqual([
      "[Compacted prior context] goal-line-2",
      "fact-c",
    ]);
  });

  test("primary complete rewrite publishes turns and evidence together", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    const history = [
      turn("fact-a"),
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_call" as const,
            id: "c1",
            name: "read_file",
            arguments: { path: "x" },
          },
        ],
        timestamp: 2,
      },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            callId: "c1",
            content: [{ type: "text" as const, text: "body" }],
          },
        ],
        timestamp: 3,
      },
    ];
    await store.writeTurns(history);
    await store.writeMetadata(EMPTY_META);
    const oldCommit = await store.commit({ message: "primary-old" });

    const archive = createCompactionArchive({
      sessionId: "primary",
      contextDir: dir,
      writeBlob: (key, bytes, contentType) =>
        store.writeBlob(key, bytes, contentType),
      readBlob: (key) => store.readBlob(key),
    });
    await archive.recordAuthorizedPayload({
      kind: "user_message",
      payload: "fact-a",
    });
    await archive.recordAuthorizedPayload({
      kind: "tool_args",
      payload: { name: "read_file", arguments: { path: "x" } },
      callId: "c1",
    });
    await archive.recordAuthorizedPayload({
      kind: "tool_result",
      payload: "body",
      callId: "c1",
    });

    const wrapped = wrapCompactorWithCompletenessGate(
      truncatingCompactor(),
      archive,
    );
    const result = await wrapped.apply(history, ctx);
    expect(result.output).not.toBe(history);
    expect(result.record.reason).toBe("compact");

    await store.writeTurns(result.output);
    expect((await store.load()).turns).toHaveLength(3);
    expect(await store.readAt(oldCommit.hash)).toHaveLength(3);

    if (result.blobs) {
      for (const blob of result.blobs) {
        await store.writeBlob(blob.key, blob.bytes, blob.contentType);
      }
    }
    await store.writeMetadata(EMPTY_META);
    await store.commit({ message: "primary-compact" });

    const loaded = await store.load();
    expect(texts(loaded.turns)).toEqual([
      "[Compacted prior context]",
      "kept-tail",
    ]);
    expect(await store.readAt(oldCommit.hash)).toHaveLength(3);

    const proc = Bun.spawn(
      ["git", "-C", dir, "ls-tree", "-r", "--name-only", "HEAD"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toContain("evidence-archive/index.jsonl");
  });
});
