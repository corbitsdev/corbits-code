import { defined } from "../../tests/helpers/defined.js";
import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import git, { type CommitObject } from "isomorphic-git";
import type { ConversationTurn } from "@intx/types/runtime";
import {
  createOptimizedContextStore,
  createSessionStores,
  loadRecentTurns,
} from "./optimized-context-store.js";
import { segmentFileName, listSegmentFiles } from "./incremental-jsonl.js";

const TURNS_FILE = "turns.jsonl";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opt-store-"));
}

async function headCommit(dir: string): Promise<CommitObject> {
  const [entry] = await git.log({ fs, dir, depth: 1 });
  if (entry === undefined) throw new Error("no commit");
  const { commit } = await git.readCommit({ fs, dir, oid: entry.oid });
  return commit;
}

const EMPTY_CHECKPOINT_METADATA = {
  pendingOperations: [],
  tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
};

async function commitEmptyCheckpoint(dir: string): Promise<void> {
  const store = await createOptimizedContextStore(dir);
  await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);
  await store.commit({ message: "checkpoint: tool-execution" });
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
    fs.writeFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 1)),
      jsonl([turn("c")]),
    );
    fs.writeFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 2)),
      jsonl([turn("d"), turn("e")]),
    );

    const loaded = await store.load();
    expect(
      loaded.turns.map((t) => (t.content[0] as { text: string }).text),
    ).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("reads a legacy monolithic turns.jsonl with no segments", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    fs.writeFileSync(path.join(dir, TURNS_FILE), jsonl([turn("only")]));

    const loaded = await store.load();
    expect(loaded.turns).toHaveLength(1);
    expect((defined(loaded.turns[0]).content[0] as { text: string }).text).toBe(
      "only",
    );
  });

  test("recovers from a torn final line in the active segment", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);

    fs.writeFileSync(path.join(dir, TURNS_FILE), jsonl([turn("a")]));
    const seg1 = path.join(dir, segmentFileName(TURNS_FILE, 1));
    fs.writeFileSync(
      seg1,
      jsonl([turn("b")]) + '{"role":"user","content":[{"type":"te',
    );

    const loaded = await store.load();
    expect(
      loaded.turns.map((t) => (t.content[0] as { text: string }).text),
    ).toEqual(["a", "b"]);
  });

  // A small session never rolls over, so the active segment is turns.jsonl
  // itself and the torn line sits in the base the isogit store parses first.
  test("recovers from a torn final line in the base segment with no extras", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);

    fs.writeFileSync(
      path.join(dir, TURNS_FILE),
      jsonl([turn("a"), turn("b")]) + '{"role":"user","content":[{"type":"te',
    );

    const loaded = await store.load();
    expect(
      loaded.turns.map((t) => (t.content[0] as { text: string }).text),
    ).toEqual(["a", "b"]);
  });

  test("keeps extra segments when the torn line is in the base segment", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);

    fs.writeFileSync(
      path.join(dir, TURNS_FILE),
      jsonl([turn("a")]) + '{"role":"user","content":[{"type":"te',
    );
    fs.writeFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 1)),
      jsonl([turn("b"), turn("c")]),
    );

    const loaded = await store.load();
    expect(
      loaded.turns.map((t) => (t.content[0] as { text: string }).text),
    ).toEqual(["a", "b", "c"]);
  });

  test("the next write heals a torn base tail so reload is stable", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);

    fs.writeFileSync(
      path.join(dir, TURNS_FILE),
      jsonl([turn("a")]) + '{"role":"user","content":[{"type":"te',
    );

    const recovered = await store.load();
    await store.writeTurns(recovered.turns);
    const reloaded = await store.load();
    expect(
      reloaded.turns.map((t) => (t.content[0] as { text: string }).text),
    ).toEqual(["a"]);
    expect(fs.readFileSync(path.join(dir, TURNS_FILE), "utf8")).toBe(
      jsonl([turn("a")]),
    );
  });

  test("recovers usable turns when turns.jsonl has a mid-file null-byte hole", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);

    const head = jsonl([turn("a"), turn("b")]);
    const tail = jsonl([turn("c")]);
    // Simulate truncate-past-EOF null padding between valid JSONL records.
    const poisoned = Buffer.concat([
      Buffer.from(head, "utf8"),
      Buffer.alloc(64, 0),
      Buffer.from(tail, "utf8"),
    ]);
    fs.writeFileSync(path.join(dir, TURNS_FILE), poisoned);

    const loaded = await store.load();
    expect(
      loaded.turns.map((t) => (t.content[0] as { text: string }).text),
    ).toEqual(["a", "b", "c"]);
  });

  test("preserves pendingOperations when turns are poisoned but metadata is valid", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);

    const head = jsonl([turn("a"), turn("b")]);
    const tail = jsonl([turn("c")]);
    const poisoned = Buffer.concat([
      Buffer.from(head, "utf8"),
      Buffer.alloc(64, 0),
      Buffer.from(tail, "utf8"),
    ]);
    fs.writeFileSync(path.join(dir, TURNS_FILE), poisoned);

    // Valid non-empty metadata must survive recovery so rehydrateGates can re-arm.
    const pendingOp = {
      correlationId: "corr-1",
      kind: "approval" as const,
      registeredAt: 1_700_000_000_000,
      gateId: "gate-1",
    };
    fs.writeFileSync(
      path.join(dir, "metadata.json"),
      JSON.stringify({
        pendingOperations: [pendingOp],
        tokenUsage: {
          input: 10,
          output: 20,
          cacheRead: 1,
          cacheWrite: 2,
          thinking: 3,
        },
        connectorState: null,
      }),
    );

    const loaded = await store.load();
    expect(
      loaded.turns.map((t) => (t.content[0] as { text: string }).text),
    ).toEqual(["a", "b", "c"]);
    expect(loaded.pendingOperations).toEqual([pendingOp]);
    expect(loaded.tokenUsage).toEqual({
      input: 10,
      output: 20,
      cacheRead: 1,
      cacheWrite: 2,
      thinking: 3,
    });
    expect(loaded.connectorState).toBeNull();
  });

  test("soft-defaults metadata when metadata.json is corrupt but turns load", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);

    fs.writeFileSync(path.join(dir, TURNS_FILE), jsonl([turn("kept")]));
    // Corrupt metadata alone must not abort resume when turns are fine.
    // Base load parses turns first then metadata — if metadata throws, recovery
    // path soft-defaults and still returns turns.
    fs.writeFileSync(path.join(dir, "metadata.json"), "{not-json\x00");

    const loaded = await store.load();
    expect(loaded.turns).toHaveLength(1);
    expect((defined(loaded.turns[0]).content[0] as { text: string }).text).toBe(
      "kept",
    );
    expect(loaded.pendingOperations).toEqual([]);
    expect(loaded.connectorState).toBeNull();
  });

  test("skips mid-file garbage lines and resumes remaining turns", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);

    // Mid-file garbage that is not null padding and not a torn tail (CL-7052).
    fs.writeFileSync(
      path.join(dir, TURNS_FILE),
      jsonl([turn("a")]) + "THIS IS NOT JSON\n" + jsonl([turn("b")]),
    );

    const loaded = await store.load();
    expect(
      loaded.turns.map((t) => (t.content[0] as { text: string }).text),
    ).toEqual(["a", "b"]);
  });

  test("skips a truncated mid-string glued to the next record", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);

    // Crash mid-write left a stub; the next append continued without a newline,
    // so a truncated prefix is glued onto the following valid record (CL-7052).
    const glued =
      '{"role":"user","content":[{"type":"te' + JSON.stringify(turn("b"));
    fs.writeFileSync(
      path.join(dir, TURNS_FILE),
      jsonl([turn("a")]) + glued + "\n" + jsonl([turn("c")]),
    );

    const loaded = await store.load();
    expect(
      loaded.turns.map((t) => (t.content[0] as { text: string }).text),
    ).toEqual(["a", "b", "c"]);
  });

  // Compacted head rewrites segment 0 while a prior multi-segment history's
  // tails stay on disk. Concatenating them reintroduces tool_call ids that the
  // compact head already kept — drop the orphan tails so the session can resume.
  test("drops orphan segment tails that reintroduce a tool_call id", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);

    const callId = "call-dup-1";
    const compactedHead: ConversationTurn[] = [
      {
        role: "user",
        content: [{ type: "text", text: "[Compacted prior context]\nsummary" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: callId, name: "grep", arguments: {} },
        ],
        timestamp: 2,
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            callId,
            content: [{ type: "text", text: "ok" }],
          },
        ],
        timestamp: 3,
      },
    ];
    const orphanTail: ConversationTurn[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: callId, name: "grep", arguments: {} },
        ],
        timestamp: 10,
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            callId,
            content: [{ type: "text", text: "stale" }],
          },
        ],
        timestamp: 11,
      },
    ];
    fs.writeFileSync(path.join(dir, TURNS_FILE), jsonl(compactedHead));
    fs.writeFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 1)),
      jsonl(orphanTail),
    );

    const loaded = await store.load();
    expect(loaded.turns).toHaveLength(3);
    expect(await listSegmentFiles(dir, TURNS_FILE)).toEqual([TURNS_FILE]);
  });

  test("drops orphan tails that reintroduce a duplicate tool_result", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    const callId = "call-result-dup";
    const head: ConversationTurn[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: callId, name: "grep", arguments: {} },
        ],
        timestamp: 1,
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            callId,
            content: [{ type: "text", text: "ok" }],
          },
        ],
        timestamp: 2,
      },
    ];
    const orphan: ConversationTurn[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            callId,
            content: [{ type: "text", text: "again" }],
          },
        ],
        timestamp: 3,
      },
    ];
    fs.writeFileSync(path.join(dir, TURNS_FILE), jsonl(head));
    fs.writeFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 1)),
      jsonl(orphan),
    );

    const loaded = await store.load();
    expect(loaded.turns).toHaveLength(2);
    expect(await listSegmentFiles(dir, TURNS_FILE)).toEqual([TURNS_FILE]);
  });

  // Rebuild (new store) → compact rewrite → third store load must not see
  // orphan tails. This is the production poison path without the reactor.
  test("rebuild then compact then reload has unique tool_call ids", async () => {
    const dir = tempDir();
    const store1 = await createOptimizedContextStore(dir);

    const callId = "call-rebuild-1";
    const history: ConversationTurn[] = [];
    const big = "x".repeat(20_000);
    // Append one-at-a-time so the segmented writer rolls past segment 0.
    for (let i = 0; i < 18; i++) {
      history.push(turn(`${i}-${big}`));
      await store1.writeTurns([...history]);
    }
    history.push({
      role: "assistant",
      content: [{ type: "tool_call", id: callId, name: "grep", arguments: {} }],
      timestamp: 100,
    });
    history.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          callId,
          content: [{ type: "text", text: "ok" }],
        },
      ],
      timestamp: 101,
    });
    await store1.writeTurns([...history]);
    await store1.writeMetadata({
      pendingOperations: [],
      tokenUsage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      },
    });
    await store1.commit({ message: "pre-rebuild" });
    expect((await listSegmentFiles(dir, TURNS_FILE)).length).toBeGreaterThan(1);

    // Agent rebuild: fresh store/writer, then compact to a short head that keeps
    // the recent tool pair (same shape as keepRecent after summarization).
    const store2 = await createOptimizedContextStore(dir);
    const compacted: ConversationTurn[] = [
      {
        role: "user",
        content: [{ type: "text", text: "[Compacted prior context]\nsummary" }],
        timestamp: 1,
      },
      defined(history[history.length - 2]),
      defined(history[history.length - 1]),
    ];
    await store2.writeTurns(compacted);
    await store2.writeMetadata({
      pendingOperations: [],
      tokenUsage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      },
    });
    await store2.commit({ message: "post-compact" });

    expect(await listSegmentFiles(dir, TURNS_FILE)).toEqual([TURNS_FILE]);

    const store3 = await createOptimizedContextStore(dir);
    const loaded = await store3.load();
    expect(loaded.turns).toHaveLength(3);
    const ids = loaded.turns.flatMap((t) =>
      t.content
        .filter((b) => b.type === "tool_call")
        .map((b) => (b as { id: string }).id),
    );
    expect(ids).toEqual([callId]);
  }, 30_000);
});

describe("loadRecentTurns", () => {
  test("reads only the tail segments needed to satisfy the window, in order", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, TURNS_FILE), jsonl([turn("a"), turn("b")]));
    fs.writeFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 1)),
      jsonl([turn("c")]),
    );
    fs.writeFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 2)),
      jsonl([turn("d"), turn("e")]),
    );

    const loaded = await loadRecentTurns(dir, 2);
    expect(loaded.map((t) => (t.content[0] as { text: string }).text)).toEqual([
      "d",
      "e",
    ]);
  });

  test("walks back into older segments when the window exceeds the newest one", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, TURNS_FILE), jsonl([turn("a"), turn("b")]));
    fs.writeFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 1)),
      jsonl([turn("c")]),
    );
    fs.writeFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 2)),
      jsonl([turn("d"), turn("e")]),
    );

    // Segment 2 (2 turns) then segment 1 (1 turn) alone fall short of the
    // window of 4, so the walk continues into segment 0 (2 turns) whole —
    // reads are segment-granular, not turn-exact.
    const loaded = await loadRecentTurns(dir, 4);
    expect(loaded.map((t) => (t.content[0] as { text: string }).text)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  test("returns an empty list when no segments exist", async () => {
    const dir = tempDir();
    expect(await loadRecentTurns(dir, 10)).toEqual([]);
  });

  test("tolerates a torn tail only in the newest segment", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, TURNS_FILE), jsonl([turn("a")]));
    fs.writeFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 1)),
      jsonl([turn("b")]) + '{"role":"user","content":[{"type":"te',
    );

    const loaded = await loadRecentTurns(dir, 5);
    expect(loaded.map((t) => (t.content[0] as { text: string }).text)).toEqual([
      "a",
      "b",
    ]);
  });

  test("skips a non-tail malformed line in the newest segment", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, TURNS_FILE), jsonl([turn("a")]));
    fs.writeFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 1)),
      jsonl([turn("b")]) +
        '{"role":"user","content":[{"type":"te\n' +
        jsonl([turn("c")]),
    );

    const loaded = await loadRecentTurns(dir, 5);
    expect(loaded.map((t) => (t.content[0] as { text: string }).text)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("skips a malformed line in an older sealed segment", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, TURNS_FILE), jsonl([turn("a")]));
    fs.writeFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 1)),
      jsonl([turn("b")]) +
        '{"role":"user","content":[{"type":"te\n' +
        jsonl([turn("c")]),
    );
    fs.writeFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 2)),
      jsonl([turn("d")]),
    );

    const loaded = await loadRecentTurns(dir, 5);
    expect(loaded.map((t) => (t.content[0] as { text: string }).text)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  test("skips a line that parses as JSON but fails the turn schema", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, TURNS_FILE), jsonl([turn("a")]));
    const badTurn = JSON.stringify({
      role: "user",
      content: "not-an-array",
      timestamp: 1,
    });
    fs.writeFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 1)),
      jsonl([turn("b")]) + badTurn + "\n" + jsonl([turn("c")]),
    );

    const loaded = await loadRecentTurns(dir, 5);
    expect(loaded.map((t) => (t.content[0] as { text: string }).text)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("reactor load skips a non-tail malformed line the same way display does", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    fs.writeFileSync(
      path.join(dir, TURNS_FILE),
      jsonl([turn("a")]) +
        '{"role":"user","content":[{"type":"te\n' +
        jsonl([turn("b")]),
    );

    const loaded = await store.load();
    expect(
      loaded.turns.map((t) => (t.content[0] as { text: string }).text),
    ).toEqual(["a", "b"]);
  });

  test("reactor load skips mid-file garbage in an extra segment", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    const segmentName = segmentFileName(TURNS_FILE, 1);

    fs.writeFileSync(path.join(dir, TURNS_FILE), jsonl([turn("a")]));
    // Mid-file garbage that is neither null padding nor a torn tail (CL-7052).
    fs.writeFileSync(
      path.join(dir, segmentName),
      jsonl([turn("b")]) + "THIS IS NOT JSON\n" + jsonl([turn("c")]),
    );

    const loaded = await store.load();
    expect(
      loaded.turns.map((t) => (t.content[0] as { text: string }).text),
    ).toEqual(["a", "b", "c"]);
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
          tokenUsage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            thinking: 0,
          },
        });
        await store.commit({ message: `turn ${i}` });
      }
    }

    expect((await listSegmentFiles(dir, TURNS_FILE)).length).toBeGreaterThan(1);

    const treeFiles = await git.listFiles({ fs, dir, ref: "HEAD" });
    expect(treeFiles.some((name) => /^turns-\d+\.jsonl$/.test(name))).toBe(
      true,
    );

    const reloaded = await createOptimizedContextStore(dir);
    const loaded = await reloaded.load();
    expect(loaded.turns).toHaveLength(total);

    const head = defined((await store.log(1))[0]);
    const atHead = await store.readAt(head.hash);
    expect(atHead).toHaveLength(total);
  }, 20_000);

  test("signs checkpoints as the interchange harness author", async () => {
    const dir = tempDir();
    await commitEmptyCheckpoint(dir);
    const commit = await headCommit(dir);
    expect(commit.author.name).toBe("interchange-harness");
    expect(commit.author.email).toBe("harness@interchange.local");
    expect(commit.committer.name).toBe("interchange-harness");
    expect(commit.committer.email).toBe("harness@interchange.local");
    expect(commit.gpgsig).toContain("BEGIN SSH SIGNATURE");
  });

  test("does not spawn system git while committing", async () => {
    const dir = tempDir();
    const gitSpawns: string[][] = [];
    const original = Bun.spawn;
    Bun.spawn = ((cmd: unknown, opts?: unknown) => {
      const argv = Array.isArray(cmd)
        ? cmd.map(String)
        : typeof cmd === "object" &&
            cmd !== null &&
            "cmd" in cmd &&
            Array.isArray(cmd.cmd)
          ? cmd.cmd.map(String)
          : [];
      if (argv[0] === "git" || argv[0]?.endsWith("/git")) gitSpawns.push(argv);
      return original(
        cmd as Parameters<typeof original>[0],
        opts as Parameters<typeof original>[1],
      );
    }) as typeof Bun.spawn;
    try {
      await commitEmptyCheckpoint(dir);
    } finally {
      Bun.spawn = original;
    }
    expect(gitSpawns).toEqual([]);
  });
});

describe("createSessionStores", () => {
  test("exposes the same object as ContextStore and AuditStore", async () => {
    const dir = tempDir();
    const { storage, audit } = await createSessionStores(dir);
    expect(Object.is(storage, audit)).toBe(true);
    expect(typeof audit.commitAudit).toBe("function");
    expect(typeof audit.commitErrors).toBe("function");
    expect(typeof audit.loadAudit).toBe("function");
  });
});

function turnTexts(turns: ConversationTurn[]): string[] {
  return turns.map((t) => (t.content[0] as { text: string }).text);
}

async function gitLsTree(dir: string): Promise<string[]> {
  const proc = Bun.spawn(["git", "-C", dir, "ls-tree", "-r", "--name-only", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ls-tree failed: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.split("\n").filter((line) => line.length > 0);
}

describe("createOptimizedContextStore unpublished rewrite", () => {
  test("rewrite writeTurns stays off the live generation until commit", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    const original = [turn("keep-a"), turn("keep-b"), turn("drop-me")];
    await store.writeTurns(original);
    await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await store.commit({ message: "published original" });

    const compacted = [turn("[Compacted prior context]"), turn("keep-b")];
    await store.writeTurns(compacted);

    const loaded = await store.load();
    expect(turnTexts(loaded.turns)).toEqual(["keep-a", "keep-b", "drop-me"]);

    await store.commit({ message: "publish compact" });
    const published = await store.load();
    expect(turnTexts(published.turns)).toEqual(["[Compacted prior context]", "keep-b"]);
  });

  test("omitting commit leaves a new store on the old generation", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    await store.writeTurns([turn("old-a"), turn("old-b")]);
    await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await store.commit({ message: "old" });

    await store.writeBlob(
      "new-blob",
      new TextEncoder().encode("needed-by-new-turns"),
      "text/plain",
    );
    await store.writeTurns([turn("[Compacted prior context]")]);

    const crashed = await createOptimizedContextStore(dir);
    const loaded = await crashed.load();
    expect(turnTexts(loaded.turns)).toEqual(["old-a", "old-b"]);
  });

  test("git commit failure after rewrite lands keeps load on HEAD", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    const original = [turn("keep-a"), turn("keep-b"), turn("drop-me")];
    await store.writeTurns(original);
    await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    const published = await store.commit({ message: "published original" });

    await store.writeTurns([turn("[Compacted prior context]"), turn("keep-b")]);

    const hookDir = path.join(dir, ".git", "hooks");
    fs.mkdirSync(hookDir, { recursive: true });
    const hook = path.join(hookDir, "commit-msg");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(hook, 0o755);

    await expect(store.commit({ message: "publish compact" })).rejects.toThrow();

    const loaded = await store.load();
    expect(turnTexts(loaded.turns)).toEqual(["keep-a", "keep-b", "drop-me"]);
    expect(turnTexts(await store.readAt(published.hash))).toEqual(["keep-a", "keep-b", "drop-me"]);
  });

  test("append writeTurns is still visible before commit", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    const first = turn("one");
    await store.writeTurns([first]);
    await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await store.commit({ message: "one" });

    await store.writeTurns([first, turn("two")]);
    const loaded = await store.load();
    expect(turnTexts(loaded.turns)).toEqual(["one", "two"]);
  });

  test("folds evidence-archive into the compact commit tree", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    await store.writeTurns([turn("old")]);
    await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await store.commit({ message: "old" });

    const archiveDir = path.join(dir, "evidence-archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, "index.jsonl"), "{}\n");
    await store.writeTurns([turn("compacted")]);
    await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await store.commit({ message: "compact" });

    expect(await gitLsTree(dir)).toContain("evidence-archive/index.jsonl");
    const loaded = await store.load();
    expect(turnTexts(loaded.turns)).toEqual(["compacted"]);
  });

  test("readAt of the old hash is not the load completeness path", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    await store.writeTurns([turn("era-1")]);
    await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    const first = await store.commit({ message: "era-1" });

    await store.writeTurns([turn("era-2")]);
    await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await store.commit({ message: "era-2" });

    expect(turnTexts(await store.readAt(first.hash))).toEqual(["era-1"]);
    expect(turnTexts((await store.load()).turns)).toEqual(["era-2"]);
  });
});
