import { defined } from "../../testkit/defined.js";
import { withFileLogSink } from "../../testkit/file-log-sink.js";
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
  versionedBaseName,
} from "./optimized-context-store.js";
import { segmentFileName, listSegmentFiles } from "./incremental-jsonl.js";
import { createPruningCompactor } from "./compactor.js";
import { LOG_NAMESPACE_ROOT } from "../branding.js";

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

// A turn gives the checkpoint content: with no pending operations there is
// no metadata.json, and a checkpoint with nothing changed commits nothing.
async function commitTurnCheckpoint(dir: string): Promise<void> {
  const store = await createOptimizedContextStore(dir);
  await store.writeTurns([turn("checkpoint")]);
  await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);
  await store.commit({ message: "checkpoint: tool-execution" });
}

function turn(text: string): ConversationTurn {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function joinedUserTurn(texts: readonly string[]): ConversationTurn {
  return {
    role: "user",
    content: texts.map((text) => ({ type: "text", text })),
    timestamp: 1,
  };
}

function isCompactionMarkerTurn(candidate: ConversationTurn): boolean {
  const block = candidate.content[0];
  if (block === undefined || block.type !== "text") return false;
  return (
    block.text.startsWith("[Compacted prior context]") ||
    block.text === "[compact]" ||
    block.text === "[compaction]"
  );
}

function jsonl(turns: ConversationTurn[]): string {
  return turns.map((t) => JSON.stringify(t)).join("\n") + "\n";
}

function turnTexts(turns: ConversationTurn[]): string[] {
  return turns.map((t) => (t.content[0] as { text: string }).text);
}

describe("createOptimizedContextStore writeMetadata approval snapshot scrubbing", () => {
  test("persists approvalSnapshot args redacted while suspendedCall keeps raw args", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    const secretArg = { api_key: "sk-test-0123456789abcdefghij" };
    const suspendedCall = {
      id: "call-1",
      name: "run_shell",
      arguments: secretArg,
    };
    const op = {
      correlationId: "corr-1",
      kind: "approval" as const,
      registeredAt: 1_700_000_000_000,
      gateId: "gate-1",
      suspendedCall,
      approvalSnapshot: {
        name: "run_shell",
        description: "runs a shell command",
        inputSchema: {},
        arguments: secretArg,
      },
    };
    // The parked call is in history before its approval is written.
    await store.writeTurns([
      {
        role: "assistant",
        content: [{ type: "tool_call", ...suspendedCall }],
        timestamp: 1,
      },
    ]);
    await store.writeMetadata({
      pendingOperations: [op],
      tokenUsage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      },
    });
    await store.commit({ message: "checkpoint: pending" });

    const [, recordLine] = fs
      .readFileSync(path.join(dir, TURNS_FILE), "utf8")
      .split("\n");
    const persisted = JSON.parse(defined(recordLine)) as {
      pendingApproval: { approvalSnapshot: { arguments: object } };
    };
    const persistedSubset = JSON.stringify(
      persisted.pendingApproval.approvalSnapshot.arguments,
    );
    // The approver-facing snapshot is redacted at rest ...
    expect(persistedSubset).not.toContain("sk-test-0123456789abcdefghij");
    // ... while the re-dispatch artifact round-trips raw: the approved call
    // runs with the same arguments the operator saw when approving.
    const loaded = await store.load();
    expect(loaded.pendingOperations[0]?.suspendedCall?.arguments).toEqual(
      secretArg,
    );
  });
});

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
    expect(turnTexts(loaded.turns)).toEqual(["a", "b", "c", "d", "e"]);
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
    expect(turnTexts(loaded.turns)).toEqual(["a", "b"]);
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
    expect(turnTexts(loaded.turns)).toEqual(["a", "b"]);
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
    expect(turnTexts(loaded.turns)).toEqual(["a", "b", "c"]);
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
    expect(turnTexts(reloaded.turns)).toEqual(["a"]);
    expect(fs.readFileSync(path.join(dir, TURNS_FILE), "utf8")).toBe(
      jsonl([turn("a")]),
    );
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
    expect(turnTexts(loaded.turns)).toEqual(["a", "b", "c"]);
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
    // Corrupt metadata alone must not abort resume when turns are fine: base
    // load parses turns first, then metadata soft-defaults on a throw.
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

    // Mid-file garbage that is not null padding and not a torn tail.
    fs.writeFileSync(
      path.join(dir, TURNS_FILE),
      jsonl([turn("a")]) + "THIS IS NOT JSON\n" + jsonl([turn("b")]),
    );

    const loaded = await store.load();
    expect(turnTexts(loaded.turns)).toEqual(["a", "b"]);
  });

  test("skips a truncated mid-string glued to the next record", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);

    // Crash mid-write left a stub; the next append continued without a newline,
    // so a truncated prefix is glued onto the following valid record.
    const glued =
      '{"role":"user","content":[{"type":"te' + JSON.stringify(turn("b"));
    fs.writeFileSync(
      path.join(dir, TURNS_FILE),
      jsonl([turn("a")]) + glued + "\n" + jsonl([turn("c")]),
    );

    const loaded = await store.load();
    expect(turnTexts(loaded.turns)).toEqual(["a", "b", "c"]);
  });

  // A compacted head rewrites segment 0 while old tails stay on disk;
  // concatenating them reintroduces tool_call ids the compact head already
  // kept — drop the orphan tails so the session can resume.
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
});

describe("createOptimizedContextStore load warnings", () => {
  function contextStoreWarnings(logged: string): string[] {
    return logged
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(
        (record) =>
          record.level === "warning" &&
          record.category === `${LOG_NAMESPACE_ROOT}.session.context-store`,
      )
      .map((record) => JSON.stringify(record));
  }

  const pendingOp = {
    correlationId: "corr-1",
    kind: "approval" as const,
    registeredAt: 1_700_000_000_000,
    gateId: "gate-1",
  };
  const usage = {
    input: 7,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    thinking: 0,
  };

  test("a cold load of a store written the current way logs no warning", async () => {
    const dir = tempDir();
    const writer = await createOptimizedContextStore(dir);
    await writer.writeTurns([turn("a"), turn("b")]);
    await writer.writeMetadata({
      pendingOperations: [pendingOp],
      tokenUsage: usage,
    });
    await writer.commit({ message: "checkpoint: tool-execution" });

    let loaded: Awaited<ReturnType<typeof writer.load>> | undefined;
    const logged = await withFileLogSink(async () => {
      const resumed = await createOptimizedContextStore(dir);
      loaded = await resumed.load();
    });

    expect(contextStoreWarnings(logged)).toEqual([]);
    expect(turnTexts(defined(loaded).turns)).toEqual(["a", "b"]);
    expect(defined(loaded).pendingOperations).toEqual([pendingOp]);
    expect(defined(loaded).tokenUsage).toEqual(usage);
  });

  test("a malformed metadata.json still warns on load", async () => {
    const dir = tempDir();
    const writer = await createOptimizedContextStore(dir);
    await writer.writeTurns([turn("a")]);
    await writer.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await writer.commit({ message: "checkpoint: tool-execution" });
    fs.writeFileSync(
      path.join(dir, "metadata.json"),
      JSON.stringify({ pendingOperations: 42 }),
    );

    let loaded: Awaited<ReturnType<typeof writer.load>> | undefined;
    const logged = await withFileLogSink(async () => {
      const resumed = await createOptimizedContextStore(dir);
      loaded = await resumed.load();
    });

    const warnings = contextStoreWarnings(logged);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("metadata.json has unexpected structure");
    expect(turnTexts(defined(loaded).turns)).toEqual(["a"]);
    expect(defined(loaded).pendingOperations).toEqual([]);
  });
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
    expect(turnTexts(loaded.turns)).toEqual(["d", "e"]);
    expect(loaded.truncated).toBe(true);
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

    // Segment 2 (2 turns) then segment 1 (1 turn) fall short of the window
    // of 4, so the walk continues into segment 0 (2 turns) whole — reads are
    // segment-granular, not turn-exact.
    const loaded = await loadRecentTurns(dir, 4);
    expect(turnTexts(loaded.turns)).toEqual(["a", "b", "c", "d", "e"]);
    expect(loaded.truncated).toBe(false);
  });

  test("returns an empty list when no segments exist", async () => {
    const dir = tempDir();
    expect(await loadRecentTurns(dir, 10)).toEqual({
      turns: [],
      truncated: false,
    });
  });

  test("a single segment that fills the window is not truncated", async () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, TURNS_FILE),
      jsonl([turn("a"), turn("b"), turn("c")]),
    );
    const loaded = await loadRecentTurns(dir, 2);
    expect(turnTexts(loaded.turns)).toEqual(["a", "b", "c"]);
    expect(loaded.truncated).toBe(false);
  });

  test("reactor load skips mid-file garbage in an extra segment", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    const segmentName = segmentFileName(TURNS_FILE, 1);

    fs.writeFileSync(path.join(dir, TURNS_FILE), jsonl([turn("a")]));
    // Mid-file garbage that is neither null padding nor a torn tail.
    fs.writeFileSync(
      path.join(dir, segmentName),
      jsonl([turn("b")]) + "THIS IS NOT JSON\n" + jsonl([turn("c")]),
    );

    const loaded = await store.load();
    expect(turnTexts(loaded.turns)).toEqual(["a", "b", "c"]);
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
    await commitTurnCheckpoint(dir);
    const commit = await headCommit(dir);
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
      await commitTurnCheckpoint(dir);
    } finally {
      Bun.spawn = original;
    }
    expect(gitSpawns).toEqual([]);
  });

  test("skips commit when no managed path differs and never stages partial.jsonl", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    const first = await store.commit({ message: "first managed checkpoint" });

    fs.writeFileSync(path.join(dir, "partial.jsonl"), '{"reason":"abort"}\n');
    fs.writeFileSync(path.join(dir, "untracked-junk.txt"), "session junk\n");
    await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);

    const second = await store.commit({ message: "empty managed checkpoint" });
    expect(second.hash).toBe(first.hash);

    const tree = await gitLsTree(dir);
    expect(tree).not.toContain("partial.jsonl");
    expect(tree).not.toContain("untracked-junk.txt");
  });

  test("commits an on-disk extra turn segment that is not in HEAD without writeTurns", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    await store.writeTurns([turn("a")]);
    fs.writeFileSync(path.join(dir, "prompt.jsonl"), jsonl([turn("p0")]));
    await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    const first = await store.commit({ message: "base" });

    const extraTurns = segmentFileName(TURNS_FILE, 1);
    const extraPrompt = segmentFileName("prompt.jsonl", 1);
    fs.writeFileSync(path.join(dir, extraTurns), jsonl([turn("b")]));
    fs.writeFileSync(path.join(dir, extraPrompt), jsonl([turn("p")]));

    const crashed = await createOptimizedContextStore(dir);
    const second = await crashed.commit({ message: "heal extra segments" });
    expect(second.hash).not.toBe(first.hash);

    const tree = await gitLsTree(dir);
    expect(tree).toContain(extraTurns);
    expect(tree).toContain(extraPrompt);
  });

  test("pending extra turn segment prevents empty-checkpoint skip", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    const turns: ConversationTurn[] = [];
    const big = "x".repeat(20_000);
    for (let i = 0; i < 14; i++) {
      turns.push(turn(`${i}-${big}`));
      await store.writeTurns([...turns]);
    }
    await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    const first = await store.commit({ message: "base" });

    for (let i = 14; i < 18; i++) {
      turns.push(turn(`${i}-${big}`));
      await store.writeTurns([...turns]);
    }
    const extraTurns = segmentFileName(TURNS_FILE, 1);
    expect(fs.existsSync(path.join(dir, extraTurns))).toBe(true);

    const second = await store.commit({ message: "pending extra" });
    expect(second.hash).not.toBe(first.hash);
    expect(await gitLsTree(dir)).toContain(extraTurns);
  });

  test("staged compact with unchanged disk still commits instead of returning HEAD", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    await store.writeTurns([turn("keep-a"), turn("keep-b"), turn("drop-me")]);
    await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    const first = await store.commit({ message: "published original" });

    await store.writeTurns([turn("[Compacted prior context]"), turn("keep-b")]);
    const second = await store.commit({ message: "publish compact" });
    expect(second.hash).not.toBe(first.hash);
    expect(turnTexts((await store.load()).turns)).toEqual([
      "[Compacted prior context]",
      "keep-b",
    ]);
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
    expect(typeof audit.loadErrors).toBe("function");
  });
});

describe("concurrent sessions write disjoint transcripts", () => {
  test("a second session sharing the dir never overwrites the first session's turns", async () => {
    const dir = tempDir();
    const storeA = await createOptimizedContextStore(dir);
    const storeB = await createOptimizedContextStore(dir);

    const turnsA = Array.from({ length: 107 }, (_, i) => turn(`a-${i}`));
    await storeA.writeTurns([...turnsA]);
    await storeA.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await storeA.commit({ message: "session A" });

    const turnsB = Array.from({ length: 7 }, (_, i) => turn(`b-${i}`));
    await storeB.writeTurns([...turnsB]);
    await storeB.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await storeB.commit({ message: "session B" });

    expect(turnTexts(readTurnsFromFile(path.join(dir, TURNS_FILE)))).toEqual(
      turnTexts(turnsA),
    );

    const versioned = versionedTurnsFiles(dir);
    expect(versioned.length).toBeGreaterThan(0);
    const bOnDisk = versioned.flatMap((name) =>
      turnTexts(readTurnsFromFile(path.join(dir, name))),
    );
    expect(bOnDisk).toEqual(turnTexts(turnsB));

    const all = [
      ...turnTexts(readTurnsFromFile(path.join(dir, TURNS_FILE))),
      ...bOnDisk,
    ];
    expect(new Set(all).size).toBe(turnsA.length + turnsB.length);
  });

  test("same-session resume with a differing first prompt keeps writing turns.jsonl", async () => {
    const dir = tempDir();

    // Reactor writes the prompt before writeTurns; that prompt may differ
    // from on-disk turns.
    const owner = await createOptimizedContextStore(dir);
    const live = [turn("a"), turn("b")];
    await owner.writeTurns([...live]);
    await owner.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await owner.commit({ message: "owner" });

    const resumed = await createOptimizedContextStore(dir);
    await resumed.writePrompt([turn("a"), turn("b"), turn("ephemeral")]);
    const next = [...live, turn("c")];
    await resumed.writeTurns([...next]);
    await resumed.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await resumed.commit({ message: "resume append" });

    expect(versionedTurnsFiles(dir)).toEqual([]);
    expect(turnTexts(readTurnsFromFile(path.join(dir, TURNS_FILE)))).toEqual(
      turnTexts(next),
    );
    expect(turnTexts((await resumed.load()).turns)).toEqual(turnTexts(next));
  });

  test("same-session compaction rewrite on resume is canonical, not diverted", async () => {
    const dir = tempDir();
    const owner = await createOptimizedContextStore(dir, {
      ownerId: "session-S",
    });
    const original = [turn("a"), turn("b"), turn("c"), turn("d")];
    await owner.writeTurns([...original]);
    await owner.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await owner.commit({ message: "owner" });

    const resumed = await createOptimizedContextStore(dir, {
      ownerId: "session-S",
    });
    const compacted = [turn("[Compacted prior context]"), turn("c"), turn("d")];
    await resumed.writeTurns([...compacted]);
    await resumed.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await resumed.commit({ message: "resume compact" });

    expect(versionedTurnsFiles(dir)).toEqual([]);
    expect(turnTexts(readTurnsFromFile(path.join(dir, TURNS_FILE)))).toEqual(
      turnTexts(compacted),
    );
    expect(turnTexts((await resumed.load()).turns)).toEqual(
      turnTexts(compacted),
    );
  });

  test("interleaved first writes cannot both claim the shared base", async () => {
    const dir = tempDir();
    const storeA = await createOptimizedContextStore(dir);
    const storeB = await createOptimizedContextStore(dir);
    const turnsA = Array.from({ length: 50 }, (_, i) => turn(`a-${i}`));
    const turnsB = Array.from({ length: 50 }, (_, i) => turn(`b-${i}`));

    await Promise.all([
      (async () => {
        await storeA.writeTurns([...turnsA]);
        await storeA.writeMetadata(EMPTY_CHECKPOINT_METADATA);
        await storeA.commit({ message: "A" });
      })(),
      (async () => {
        await storeB.writeTurns([...turnsB]);
        await storeB.writeMetadata(EMPTY_CHECKPOINT_METADATA);
        await storeB.commit({ message: "B" });
      })(),
    ]);

    const shared = turnTexts(readTurnsFromFile(path.join(dir, TURNS_FILE)));
    const versioned = versionedTurnsFiles(dir);
    expect(versioned).toHaveLength(1);
    const other = turnTexts(
      readTurnsFromFile(path.join(dir, defined(versioned[0]))),
    );
    const sharedIsA =
      JSON.stringify(shared) === JSON.stringify(turnTexts(turnsA));
    const sharedIsB =
      JSON.stringify(shared) === JSON.stringify(turnTexts(turnsB));
    expect(sharedIsA || sharedIsB).toBe(true);
    expect(other).toEqual(sharedIsA ? turnTexts(turnsB) : turnTexts(turnsA));
    expect(new Set([...shared, ...other]).size).toBe(
      turnsA.length + turnsB.length,
    );
  });

  test("crash before the divert lands leaves no orphaned versioned file", async () => {
    const dir = tempDir();
    const owner = await createOptimizedContextStore(dir);
    await owner.writeTurns([turn("a"), turn("b")]);
    await owner.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await owner.commit({ message: "owner" });

    const foreign = await createOptimizedContextStore(dir);
    await foreign.writeTurns([turn("x"), turn("y")]);
    expect(versionedTurnsFiles(dir)).toEqual([]);

    const resumed = await createOptimizedContextStore(dir);
    await resumed.writeTurns([turn("a"), turn("b"), turn("c")]);
    await resumed.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await resumed.commit({ message: "resume" });
    expect(versionedTurnsFiles(dir)).toEqual([]);
    expect(turnTexts(readTurnsFromFile(path.join(dir, TURNS_FILE)))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("markerless foreign turns stay off the shared log", async () => {
    const dir = tempDir();
    const sessionA = await createOptimizedContextStore(dir, {
      ownerId: "session-A",
    });
    const turnsA = [
      turn("a-0"),
      turn("a-1"),
      turn("a-2"),
      turn("a-3"),
      turn("a-4"),
    ];
    await sessionA.writeTurns([...turnsA]);
    await sessionA.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await sessionA.commit({ message: "session A" });
    fs.unlinkSync(path.join(dir, "session-owner.json"));

    const sessionB = await createOptimizedContextStore(dir, {
      ownerId: "session-B",
    });
    const turnsB = [turn("b-0"), turn("b-1"), turn("b-2")];
    await sessionB.writeTurns([...turnsB]);
    expect(turnTexts(readTurnsFromFile(path.join(dir, TURNS_FILE)))).toEqual(
      turnTexts(turnsA),
    );
    expect(versionedTurnsFiles(dir)).toEqual([]);

    await sessionB.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await sessionB.commit({ message: "session B" });
    expect(turnTexts(readTurnsFromFile(path.join(dir, TURNS_FILE)))).toEqual(
      turnTexts(turnsA),
    );
    const versioned = versionedTurnsFiles(dir);
    expect(versioned).toHaveLength(1);
    expect(
      turnTexts(readTurnsFromFile(path.join(dir, defined(versioned[0])))),
    ).toEqual(turnTexts(turnsB));
  });

  test("markerless resume can still extend the shared log", async () => {
    const dir = tempDir();
    const sessionA = await createOptimizedContextStore(dir);
    const turnsA = [turn("a"), turn("b")];
    await sessionA.writeTurns([...turnsA]);
    await sessionA.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await sessionA.commit({ message: "session A" });
    fs.unlinkSync(path.join(dir, "session-owner.json"));

    const resumed = await createOptimizedContextStore(dir);
    const next = [...turnsA, turn("c")];
    await resumed.writeTurns([...next]);
    await resumed.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await resumed.commit({ message: "resume" });
    expect(versionedTurnsFiles(dir)).toEqual([]);
    expect(turnTexts(readTurnsFromFile(path.join(dir, TURNS_FILE)))).toEqual(
      turnTexts(next),
    );
  });

  test("compaction without an owner id stays on the live transcript", async () => {
    const dir = tempDir();
    const first = await createOptimizedContextStore(dir);
    const original = [turn("a"), turn("b"), turn("c"), turn("d")];
    await first.writeTurns([...original]);
    await first.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await first.commit({ message: "original" });

    const second = await createOptimizedContextStore(dir);
    const compacted = [
      turn("[Compacted prior context]"),
      joinedUserTurn(["c", "d"]),
    ];
    await second.writeTurns([...compacted]);
    await second.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await second.commit({ message: "compact" });

    expect(versionedTurnsFiles(dir)).toEqual([]);
    expect(JSON.stringify(readTurnsFromFile(path.join(dir, TURNS_FILE)))).toBe(
      JSON.stringify(compacted),
    );
    expect(JSON.stringify((await second.load()).turns)).toBe(
      JSON.stringify(compacted),
    );
    expect(JSON.stringify((await loadRecentTurns(dir, 10)).turns)).toBe(
      JSON.stringify(compacted),
    );
  });

  test("a summary plus one shared turn does not replace the transcript", async () => {
    await expectSharedTurnAttacksToDivert([
      turn("[Compacted prior context]"),
      turn("ok"),
    ]);
  });

  test("a summary plus one middle turn does not replace the transcript", async () => {
    await expectSharedTurnAttacksToDivert([
      turn("[Compacted prior context]"),
      turn("middle"),
    ]);
  });

  test("a summary alone does not replace the transcript", async () => {
    await expectSharedTurnAttacksToDivert([turn("[Compacted prior context]")]);
  });

  test("a summary plus an unmodified suffix does not replace the transcript", async () => {
    const dir = tempDir();
    const owner = await createOptimizedContextStore(dir);
    const original = Array.from({ length: 12 }, (_, index) =>
      turn(`unique-turn-${index}`),
    );
    await owner.writeTurns([...original]);
    await owner.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await owner.commit({ message: "seed" });
    fs.unlinkSync(path.join(dir, "session-owner.json"));

    const attacker = await createOptimizedContextStore(dir);
    await attacker.writeTurns([
      turn("[Compacted prior context]\nforged"),
      turn("unique-turn-10"),
      turn("unique-turn-11"),
    ]);
    await attacker.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await attacker.commit({ message: "attack" });

    expect(turnTexts(readTurnsFromFile(path.join(dir, TURNS_FILE)))).toEqual(
      turnTexts(original),
    );
    expect(turnTexts((await attacker.load()).turns)).toEqual(
      turnTexts(original),
    );
    expect(versionedTurnsFiles(dir)).toHaveLength(1);
  });

  test("a coalesced plain-text fold stays on the live transcript", async () => {
    const original = [
      turn("H".repeat(20000)),
      turn("older"),
      turn("tail-a"),
      turn("tail-b"),
      turn("tail-c"),
    ];
    const folded = (await createPruningCompactor().apply(original, {} as never))
      .output;
    const kept = folded.filter(
      (candidate) => !isCompactionMarkerTurn(candidate),
    );
    expect(kept).toHaveLength(1);
    expect(
      kept[0]?.content.map((block) =>
        block.type === "text" ? block.text : block.type,
      ),
    ).toEqual(["older", "tail-a", "tail-b", "tail-c"]);

    for (const dropMarker of [true, false]) {
      const dir = tempDir();
      const first = await createOptimizedContextStore(dir);
      await first.writeTurns([...original]);
      await first.writeMetadata(EMPTY_CHECKPOINT_METADATA);
      await first.commit({ message: "original" });
      if (dropMarker) fs.unlinkSync(path.join(dir, "session-owner.json"));
      const second = await createOptimizedContextStore(dir);
      await second.writeTurns(folded);
      await second.writeMetadata(EMPTY_CHECKPOINT_METADATA);
      await second.commit({ message: "fold" });
      const later = [...folded, turn("after-fold")];
      await second.writeTurns(later);
      await second.writeMetadata(EMPTY_CHECKPOINT_METADATA);
      await second.commit({ message: "later" });

      expect(versionedTurnsFiles(dir)).toEqual([]);
      expect(
        JSON.stringify(readTurnsFromFile(path.join(dir, TURNS_FILE))),
      ).toBe(JSON.stringify(later));
      expect(JSON.stringify((await second.load()).turns)).toBe(
        JSON.stringify(later),
      );
    }
  });

  test("a foreign transcript without an owner id still diverts", async () => {
    const dir = tempDir();
    const first = await createOptimizedContextStore(dir);
    const original = [turn("a"), turn("b"), turn("c"), turn("d")];
    await first.writeTurns([...original]);
    await first.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await first.commit({ message: "original" });

    const second = await createOptimizedContextStore(dir);
    const foreign = [turn("x"), turn("y")];
    await second.writeTurns([...foreign]);
    await second.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await second.commit({ message: "foreign" });

    expect(turnTexts(readTurnsFromFile(path.join(dir, TURNS_FILE)))).toEqual(
      turnTexts(original),
    );
    const versioned = versionedTurnsFiles(dir);
    expect(versioned).toHaveLength(1);
    expect(
      turnTexts(readTurnsFromFile(path.join(dir, defined(versioned[0])))),
    ).toEqual(turnTexts(foreign));
    expect(turnTexts((await loadRecentTurns(dir, 10)).turns)).toEqual(
      turnTexts(original),
    );
  });

  test("a pruned compaction stays on the live transcript", async () => {
    const readCall = (id: string): ConversationTurn => ({
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id,
          name: "read_file",
          arguments: { path: "src/hot.ts" },
        },
      ],
      timestamp: 1,
    });
    const readResult = (id: string, text: string): ConversationTurn => ({
      role: "user",
      content: [
        {
          type: "tool_result",
          callId: id,
          content: [{ type: "text", text }],
        },
      ],
      timestamp: 1,
    });
    const original: ConversationTurn[] = [
      turn("start the migration and keep the auth notes"),
      turn("constraint: do not rewrite the session log"),
      readCall("old-a"),
      readResult("old-a", `FOLD_${"c".repeat(8000)}`),
      readCall("old-b"),
      readResult("old-b", `FOLD_${"d".repeat(8000)}`),
      readCall("old-c"),
      readResult("old-c", `FOLD_${"e".repeat(8000)}`),
      readCall("r1"),
      readResult("r1", `OLD_${"a".repeat(3000)}`),
      readCall("r2"),
      readResult("r2", `NEW_${"b".repeat(3000)}`),
      turn("continue from the latest read"),
    ];
    const folded = (await createPruningCompactor().apply(original, {} as never))
      .output;
    const unequal = folded.filter(
      (candidate) =>
        !original.some(
          (source) => JSON.stringify(source) === JSON.stringify(candidate),
        ),
    );
    expect(unequal.length).toBeGreaterThan(0);
    const foldedText = JSON.stringify(folded);
    expect(foldedText).toContain("[tail-shortened ");
    expect(foldedText).toContain("omitted from context");
    expect(
      folded.some((candidate) =>
        candidate.content.some(
          (block) =>
            block.type === "text" &&
            block.text.startsWith("[Compacted prior context]"),
        ),
      ),
    ).toBe(true);

    const publish = async (
      ownerId: string | undefined,
      dropMarker: boolean,
    ): Promise<void> => {
      const dir = tempDir();
      const first = await createOptimizedContextStore(dir);
      await first.writeTurns([...original]);
      await first.writeMetadata(EMPTY_CHECKPOINT_METADATA);
      await first.commit({ message: "original" });
      if (dropMarker) fs.unlinkSync(path.join(dir, "session-owner.json"));
      const second = await createOptimizedContextStore(
        dir,
        ownerId === undefined ? undefined : { ownerId },
      );
      await second.writeTurns(folded);
      await second.writeMetadata(EMPTY_CHECKPOINT_METADATA);
      await second.commit({ message: "fold" });
      const later = [...folded, turn("after-fold")];
      await second.writeTurns(later);
      await second.writeMetadata(EMPTY_CHECKPOINT_METADATA);
      await second.commit({ message: "later" });

      expect(versionedTurnsFiles(dir)).toEqual([]);
      expect(
        JSON.stringify(readTurnsFromFile(path.join(dir, TURNS_FILE))),
      ).toBe(JSON.stringify(later));
      expect(JSON.stringify((await second.load()).turns)).toBe(
        JSON.stringify(later),
      );
    };

    await publish(undefined, false);
    await publish("session-S", true);
  });

  test("an owner id can compact a markerless transcript in place", async () => {
    const dir = tempDir();
    const legacy = await createOptimizedContextStore(dir);
    const original = [turn("a"), turn("b"), turn("c"), turn("d")];
    await legacy.writeTurns([...original]);
    await legacy.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await legacy.commit({ message: "legacy" });
    fs.unlinkSync(path.join(dir, "session-owner.json"));

    const upgraded = await createOptimizedContextStore(dir, {
      ownerId: "session-S",
    });
    const compacted = [
      turn("[Compacted prior context]"),
      joinedUserTurn(["c", "d"]),
    ];
    await upgraded.writeTurns([...compacted]);
    await upgraded.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await upgraded.commit({ message: "upgrade compact" });

    expect(versionedTurnsFiles(dir)).toEqual([]);
    expect(JSON.stringify(readTurnsFromFile(path.join(dir, TURNS_FILE)))).toBe(
      JSON.stringify(compacted),
    );
    expect(JSON.stringify((await upgraded.load()).turns)).toBe(
      JSON.stringify(compacted),
    );
  });

  test("a foreign prefix extension is kept when the owner compacts", async () => {
    const dir = tempDir();
    const sessionA = await createOptimizedContextStore(dir, {
      ownerId: "session-A",
    });
    await sessionA.writeTurns([turn("a"), turn("b")]);
    await sessionA.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await sessionA.commit({ message: "session A" });

    const sessionB = await createOptimizedContextStore(dir, {
      ownerId: "session-B",
    });
    await sessionB.writeTurns([turn("a"), turn("b"), turn("from-B")]);
    await sessionB.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await sessionB.commit({ message: "session B" });
    expect(turnTexts(readTurnsFromFile(path.join(dir, TURNS_FILE)))).toEqual([
      "a",
      "b",
    ]);

    const sessionA2 = await createOptimizedContextStore(dir, {
      ownerId: "session-A",
    });
    await sessionA2.writeTurns([turn("[Compacted prior context]"), turn("b")]);
    await sessionA2.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await sessionA2.commit({ message: "compact" });

    expect(turnTexts(readTurnsFromFile(path.join(dir, TURNS_FILE)))).toEqual([
      "[Compacted prior context]",
      "b",
    ]);
    const preserved = versionedTurnsFiles(dir).flatMap((name) =>
      turnTexts(readTurnsFromFile(path.join(dir, name))),
    );
    expect(preserved).toContain("from-B");
  });

  test("a foreign write after an empty owned file is not discarded", async () => {
    const dir = tempDir();
    const sessionA = await createOptimizedContextStore(dir, {
      ownerId: "session-A",
    });
    await sessionA.writeTurns([turn("seed")]);
    fs.unlinkSync(path.join(dir, TURNS_FILE));

    const sessionB = await createOptimizedContextStore(dir, {
      ownerId: "session-B",
    });
    await sessionB.writeTurns([turn("a"), turn("b"), turn("from-B")]);
    await sessionB.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await sessionB.commit({ message: "session B" });

    const resumed = await createOptimizedContextStore(dir, {
      ownerId: "session-A",
    });
    await resumed.writeTurns([turn("[Compacted prior context]"), turn("b")]);
    await resumed.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await resumed.commit({ message: "compact" });

    const preserved = versionedTurnsFiles(dir).flatMap((name) =>
      turnTexts(readTurnsFromFile(path.join(dir, name))),
    );
    expect(preserved).toContain("from-B");
    expect(turnTexts((await resumed.load()).turns)).not.toContain("from-B");
  });

  test(
    "two processes cannot both claim an empty session directory",
    async () => {
      const workerPath = path.join(
        os.tmpdir(),
        `claim-worker-${process.pid}.ts`,
      );
      const storeModule = path.join(
        import.meta.dir,
        "optimized-context-store.ts",
      );
      fs.writeFileSync(
        workerPath,
        `import fs from "node:fs";
import { createOptimizedContextStore } from ${JSON.stringify(storeModule)};

const dir = process.env.CLAIM_DIR;
const ownerId = process.env.CLAIM_OWNER;
const label = process.env.CLAIM_LABEL;
if (dir === undefined || ownerId === undefined || label === undefined) {
  throw new Error("missing claim env");
}
const turn = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
await fs.promises.writeFile(dir + "/ready-" + ownerId, "");
while (!fs.existsSync(dir + "/go")) {
  await Bun.sleep(5);
}
const store = await createOptimizedContextStore(dir, { ownerId });
const turns = Array.from({ length: 30 }, (_, i) => turn(label + "-" + i));
await store.writeTurns(turns);
await store.writeMetadata({
  pendingOperations: [],
  tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
});
const lockPath = dir + "/commit.lock";
for (;;) {
  try {
    const handle = await fs.promises.open(lockPath, "wx");
    await handle.close();
    break;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "EEXIST") {
      await Bun.sleep(10);
      continue;
    }
    throw cause;
  }
}
try {
  await store.commit({ message: label });
} finally {
  await fs.promises.unlink(lockPath).catch(() => undefined);
}
`,
      );

      try {
        for (let attempt = 0; attempt < 6; attempt++) {
          const dir = tempDir();
          const seed = await createOptimizedContextStore(dir, {
            ownerId: "seed",
          });
          await seed.writeMetadata(EMPTY_CHECKPOINT_METADATA);
          await seed.commit({ message: "init" });

          const spawnClaim = (ownerId: string, label: string) =>
            Bun.spawn(["bun", workerPath], {
              cwd: path.resolve(import.meta.dir, "../.."),
              env: {
                ...process.env,
                CLAIM_DIR: dir,
                CLAIM_OWNER: ownerId,
                CLAIM_LABEL: label,
              },
              stdout: "pipe",
              stderr: "pipe",
            });
          const procA = spawnClaim("owner-A", "A");
          const procB = spawnClaim("owner-B", "B");
          const readyA = path.join(dir, "ready-owner-A");
          const readyB = path.join(dir, "ready-owner-B");
          const deadline = Date.now() + 15_000;
          while (
            (!fs.existsSync(readyA) || !fs.existsSync(readyB)) &&
            Date.now() < deadline
          ) {
            await Bun.sleep(5);
          }
          fs.writeFileSync(path.join(dir, "go"), "");
          const [codeA, codeB, errA, errB] = await Promise.all([
            procA.exited,
            procB.exited,
            new Response(procA.stderr).text(),
            new Response(procB.stderr).text(),
          ]);
          if (codeA !== 0 || codeB !== 0) {
            throw new Error(
              `claim workers failed (${codeA}, ${codeB})\n${errA}\n${errB}`,
            );
          }
          const shared = turnTexts(
            readTurnsFromFile(path.join(dir, TURNS_FILE)),
          );
          const versioned = versionedTurnsFiles(dir);
          expect(versioned).toHaveLength(1);
          const other = turnTexts(
            readTurnsFromFile(path.join(dir, defined(versioned[0]))),
          );
          const sharedLabel = shared[0]?.split("-")[0];
          const otherLabel = other[0]?.split("-")[0];
          expect(new Set([sharedLabel, otherLabel])).toEqual(
            new Set(["A", "B"]),
          );
          expect(shared).toHaveLength(30);
          expect(other).toHaveLength(30);
          expect(
            shared.every((text) => text.startsWith(`${sharedLabel}-`)),
          ).toBe(true);
          expect(other.every((text) => text.startsWith(`${otherLabel}-`))).toBe(
            true,
          );
        }
      } finally {
        fs.unlinkSync(workerPath);
      }
    },
    { timeout: 60_000 },
  );

  test("versioned base names are unique even within the same millisecond", () => {
    const names = Array.from({ length: 100 }, () =>
      versionedBaseName(TURNS_FILE),
    );
    expect(new Set(names).size).toBe(100);
    for (const name of names) {
      expect(/^turns-\d+-[0-9a-f]+\.jsonl$/.test(name)).toBe(true);
    }
  });
});

function versionedTurnsFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => /^turns-\d+-[0-9a-f]+\.jsonl$/.test(name));
}

function fiveTurnsEndingOk(): ConversationTurn[] {
  return [
    turn("alpha"),
    turn("middle"),
    turn("gamma"),
    turn("delta"),
    turn("ok"),
  ];
}

async function expectSharedTurnAttacksToDivert(
  attack: readonly ConversationTurn[],
): Promise<void> {
  for (const markerless of [true, false]) {
    const dir = tempDir();
    const owner = await createOptimizedContextStore(dir, {
      ownerId: "session-owner",
    });
    const original = fiveTurnsEndingOk();
    await owner.writeTurns([...original]);
    await owner.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await owner.commit({ message: "seed" });
    if (markerless) fs.unlinkSync(path.join(dir, "session-owner.json"));

    const attacker = await createOptimizedContextStore(dir);
    await attacker.writeTurns([...attack]);
    await attacker.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await attacker.commit({ message: "attack" });

    expect(turnTexts(readTurnsFromFile(path.join(dir, TURNS_FILE)))).toEqual(
      turnTexts(original),
    );
    expect(turnTexts((await attacker.load()).turns)).toEqual(
      turnTexts(original),
    );
    expect(versionedTurnsFiles(dir)).toHaveLength(1);
  }
}

function readTurnsFromFile(fullPath: string): ConversationTurn[] {
  const text = fs.readFileSync(fullPath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ConversationTurn);
}

async function gitLsTree(dir: string): Promise<string[]> {
  const proc = Bun.spawn(
    ["git", "-C", dir, "ls-tree", "-r", "--name-only", "HEAD"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
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
    expect(turnTexts(published.turns)).toEqual([
      "[Compacted prior context]",
      "keep-b",
    ]);
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

    // The store commits through isomorphic-git, which never runs hooks. Force
    // a deterministic commit failure instead: replace .git/objects with a
    // regular file so every object write fails with ENOTDIR, then restore it
    // so the readAt assertion below can read the published commit.
    const objectsDir = path.join(dir, ".git", "objects");
    const objectsHeld = `${objectsDir}.held`;
    fs.renameSync(objectsDir, objectsHeld);
    fs.writeFileSync(objectsDir, "held");
    try {
      await expect(
        store.commit({ message: "publish compact" }),
      ).rejects.toThrow();
    } finally {
      fs.unlinkSync(objectsDir);
      fs.renameSync(objectsHeld, objectsDir);
    }

    const loaded = await store.load();
    expect(turnTexts(loaded.turns)).toEqual(["keep-a", "keep-b", "drop-me"]);
    expect(turnTexts(await store.readAt(published.hash))).toEqual([
      "keep-a",
      "keep-b",
      "drop-me",
    ]);

    // The failed commit keeps the rewrite staged: retrying publishes it.
    await store.commit({ message: "retry publish compact" });
    const retried = await store.load();
    expect(turnTexts(retried.turns)).toEqual([
      "[Compacted prior context]",
      "keep-b",
    ]);
  });

  test("a failed commit does not publish a same-owner compaction", async () => {
    const dir = tempDir();
    const owner = await createOptimizedContextStore(dir, {
      ownerId: "session-S",
    });
    const original = [turn("keep-a"), turn("keep-b"), turn("drop-me")];
    await owner.writeTurns([...original]);
    await owner.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    const published = await owner.commit({ message: "published original" });

    const resumed = await createOptimizedContextStore(dir, {
      ownerId: "session-S",
    });
    await resumed.writeTurns([
      turn("[Compacted prior context]"),
      turn("keep-b"),
    ]);
    expect(turnTexts(readTurnsFromFile(path.join(dir, TURNS_FILE)))).toEqual(
      turnTexts(original),
    );

    const objectsDir = path.join(dir, ".git", "objects");
    const objectsHeld = `${objectsDir}.held`;
    fs.renameSync(objectsDir, objectsHeld);
    fs.writeFileSync(objectsDir, "held");
    try {
      await expect(
        resumed.commit({ message: "publish compact" }),
      ).rejects.toThrow();
    } finally {
      fs.unlinkSync(objectsDir);
      fs.renameSync(objectsHeld, objectsDir);
    }

    expect(turnTexts(readTurnsFromFile(path.join(dir, TURNS_FILE)))).toEqual(
      turnTexts(original),
    );
    expect(turnTexts((await resumed.load()).turns)).toEqual(
      turnTexts(original),
    );
    expect(turnTexts(await resumed.readAt(published.hash))).toEqual(
      turnTexts(original),
    );
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

describe("createOptimizedContextStore per-turn perf (CL-10666)", () => {
  const SEGMENT_MANIFEST_FILE = "segment-manifest.json";

  test("an orphan extra in the middle drops it and everything after it", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    const callId = "call-middle-orphan";

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
    // [well-formed, orphan, well-formed] — the incremental pass must stop at
    // the orphan exactly where the old rescan-per-length loop did: keep 1 of
    // 3 extras (segment 1), unlink segments 2 and 3.
    const good: ConversationTurn[] = [
      {
        role: "user",
        content: [{ type: "text", text: "kept" }],
        timestamp: 10,
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
        timestamp: 20,
      },
    ];
    fs.writeFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 1)),
      jsonl(good),
    );
    fs.writeFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 2)),
      jsonl(orphan),
    );
    fs.writeFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 3)),
      jsonl([turn("last")]),
    );
    fs.writeFileSync(path.join(dir, TURNS_FILE), jsonl(head));

    const loaded = await store.load();
    expect(loaded.turns).toHaveLength(3);
    expect(turnTexts(loaded.turns)).toEqual([...turnTexts(head), "kept"]);
    expect(await listSegmentFiles(dir, TURNS_FILE)).toEqual([
      TURNS_FILE,
      segmentFileName(TURNS_FILE, 1),
    ]);
  });

  test("loads observe external segment mutations, byte-identical edits included", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    fs.writeFileSync(path.join(dir, TURNS_FILE), jsonl([turn("a"), turn("b")]));
    fs.writeFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 1)),
      jsonl([turn("c")]),
    );
    expect(turnTexts((await store.load()).turns)).toEqual(["a", "b", "c"]);

    // Crash-artifact appends land in the active segment between loads; the
    // cached generation must invalidate (stat change) and merge them.
    fs.appendFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 1)),
      jsonl([turn("d")]),
    );
    expect(turnTexts((await store.load()).turns)).toEqual(["a", "b", "c", "d"]);

    // Same-length rewrite of the active segment ("c" -> "x") still invalidates.
    fs.writeFileSync(
      path.join(dir, segmentFileName(TURNS_FILE, 1)),
      jsonl([turn("x"), turn("d")]),
    );
    expect(turnTexts((await store.load()).turns)).toEqual(["a", "b", "x", "d"]);

    // Torn tail on the active segment keeps dropping it stably.
    const active = path.join(dir, segmentFileName(TURNS_FILE, 1));
    fs.writeFileSync(
      active,
      jsonl([turn("x"), turn("d")]) + '{"role":"user","content":[{"type":"te',
    );
    expect(turnTexts((await store.load()).turns)).toEqual(["a", "b", "x", "d"]);
  });

  test("commits a segment manifest only when turn extras exist and readAt consults it", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    const bigText = "x".repeat(300 * 1024);
    const bigTurn: ConversationTurn = {
      role: "user",
      content: [{ type: "text", text: bigText }],
      timestamp: 1,
    };
    await store.writeTurns([bigTurn]);
    await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    const first = await store.commit({ message: "base only" });
    expect(fs.existsSync(path.join(dir, SEGMENT_MANIFEST_FILE))).toBe(false);

    const last = turn("tail");
    await store.writeTurns([bigTurn, last]);
    await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    const second = await store.commit({ message: "with extra" });
    const extraTurns = segmentFileName(TURNS_FILE, 1);
    expect(fs.existsSync(path.join(dir, SEGMENT_MANIFEST_FILE))).toBe(true);
    const tree = await gitLsTree(dir);
    expect(tree).toContain(SEGMENT_MANIFEST_FILE);
    expect(
      fs.readFileSync(path.join(dir, SEGMENT_MANIFEST_FILE), "utf-8"),
    ).toBe(JSON.stringify({ turnSegments: [extraTurns] }));

    // Manifest path and tree-walk path agree.
    expect(turnTexts(await store.readAt(second.hash))).toEqual([
      bigText,
      "tail",
    ]);
    expect(await store.readAt(first.hash)).toHaveLength(1);
  });

  test("a corrupt committed segment manifest falls back to the commit-tree walk", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    const bigText = "x".repeat(300 * 1024);
    const bigTurn: ConversationTurn = {
      role: "user",
      content: [{ type: "text", text: bigText }],
      timestamp: 1,
    };
    await store.writeTurns([bigTurn, turn("tail")]);
    await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await store.commit({ message: "with extra" });

    fs.writeFileSync(path.join(dir, SEGMENT_MANIFEST_FILE), "{torn");
    await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    const after = await store.commit({ message: "corrupt manifest" });

    expect(turnTexts(await store.readAt(after.hash))).toEqual([
      bigText,
      "tail",
    ]);
    await store.writeTurns([bigTurn, turn("tail"), turn("newer")]);
    await store.writeMetadata(EMPTY_CHECKPOINT_METADATA);
    await store.commit({ message: "heal manifest" });
    expect(
      fs.readFileSync(path.join(dir, SEGMENT_MANIFEST_FILE), "utf-8"),
    ).toBe(JSON.stringify({ turnSegments: [segmentFileName(TURNS_FILE, 1)] }));
  });
});

describe("createOptimizedContextStore response fold (CL-10667)", () => {
  test("writeResponse touches no disk and a commit does not reintroduce the file", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    await store.writeTurns([turn("a")]);
    await store.writeResponse({
      role: "assistant",
      content: [{ type: "text", text: "reply" }],
      model: "m",
      timestamp: 2,
    });
    expect(fs.existsSync(path.join(dir, "response.jsonl"))).toBe(false);
    await store.commit({ message: "fold" });
    const tree = await git.listFiles({ fs, dir, ref: "HEAD" });
    expect(tree.includes("response.jsonl")).toBe(false);
    expect(fs.existsSync(path.join(dir, "response.jsonl"))).toBe(false);
  });
});

describe("createOptimizedContextStore manifest skip (CL-10667)", () => {
  test("an empty buffer converges manifest.jsonl to absent by the next commit", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    await store.writeTurns([turn("a")]);
    await store.writeManifest([
      {
        strategy: "test.transform",
        version: "1",
        parameters: {},
        reason: "ingest",
        decisions: {},
      },
    ]);
    await store.commit({ message: "with manifest" });
    expect(
      (await git.listFiles({ fs, dir, ref: "HEAD" })).includes(
        "manifest.jsonl",
      ),
    ).toBe(true);

    await store.writeManifest([]);
    expect(fs.existsSync(path.join(dir, "manifest.jsonl"))).toBe(false);
    await store.commit({ message: "empty buffer" });
    expect(
      (await git.listFiles({ fs, dir, ref: "HEAD" })).includes(
        "manifest.jsonl",
      ),
    ).toBe(false);
    // readManifestHistory walks the commit chain: the earlier commit's
    // records are still its history, exactly as they were when an empty
    // write produced an empty blob; the converged worktree only removes the
    // HEAD blob, not history.
    expect(await store.readManifestHistory(5)).toEqual([
      {
        strategy: "test.transform",
        version: "1",
        parameters: {},
        reason: "ingest",
        decisions: {},
      },
    ]);
  });

  test("repeated empty buffers are disk no-ops", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    await store.writeManifest([]);
    await store.writeManifest([]);
    expect(fs.existsSync(path.join(dir, "manifest.jsonl"))).toBe(false);
  });

  test("a non-empty buffer still writes and stages the manifest", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    await store.writeTurns([turn("a")]);
    await store.writeManifest([]);
    await store.commit({ message: "prune" });
    await store.writeManifest([
      {
        strategy: "test.transform",
        version: "1",
        parameters: {},
        reason: "ingest",
        decisions: {},
      },
    ]);
    const committed = await store.commit({ message: "re-write manifest" });
    expect(
      (await git.listFiles({ fs, dir, ref: committed.hash })).includes(
        "manifest.jsonl",
      ),
    ).toBe(true);
  });
});

describe("createOptimizedContextStore metadata ownership (CL-10667)", () => {
  const USAGE_ONE = {
    input: 10,
    output: 20,
    cacheRead: 1,
    cacheWrite: 2,
    thinking: 3,
  };
  const USAGE_TWO = {
    input: 110,
    output: 220,
    cacheRead: 1,
    cacheWrite: 2,
    thinking: 3,
  };
  const pendingOp = {
    correlationId: "corr-1",
    kind: "approval" as const,
    registeredAt: 1_700_000_000_000,
    gateId: "gate-1",
  };

  test("writeMetadata keeps pendingOperations on metadata.json and usage on the sidecar", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    await store.writeMetadata({
      pendingOperations: [pendingOp],
      tokenUsage: USAGE_ONE,
    });

    const metadata = JSON.parse(
      fs.readFileSync(path.join(dir, "metadata.json"), "utf8"),
    );
    expect(metadata.pendingOperations).toEqual([pendingOp]);
    expect(metadata.connectorState).toBeNull();
    expect(Object.keys(metadata).includes("tokenUsage")).toBe(false);

    const sidecar = fs
      .readFileSync(path.join(dir, "token-usage.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(sidecar).toHaveLength(1);
    expect(JSON.parse(defined(sidecar[0]))).toHaveProperty("usage", USAGE_ONE);

    // A fresh store reads the sidecar over the rewritten metadata.
    const fresh = await createOptimizedContextStore(dir);
    const loaded = await fresh.load();
    expect(loaded.pendingOperations).toEqual([pendingOp]);
    expect(loaded.tokenUsage).toEqual(USAGE_ONE);
  });

  test("unchanged usage appends no sidecar line and identical metadata skips the rewrite", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    await store.writeMetadata({
      pendingOperations: [pendingOp],
      tokenUsage: USAGE_ONE,
    });
    const sidecarPath = path.join(dir, "token-usage.jsonl");
    const metadataPath = path.join(dir, "metadata.json");
    expect((await fs.promises.stat(sidecarPath)).mtimeMs).toBeGreaterThan(0);
    expect(
      fs.readFileSync(sidecarPath, "utf8").trim().split("\n"),
    ).toHaveLength(1);
    // Stamp a long-gone mtime: a rewrite would move it.
    await fs.promises.utimes(metadataPath, new Date(9e11), new Date(9e11));
    await store.writeMetadata({
      pendingOperations: [pendingOp],
      tokenUsage: USAGE_ONE,
    });
    expect(
      fs.readFileSync(sidecarPath, "utf8").trim().split("\n"),
    ).toHaveLength(1);
    expect((await fs.promises.stat(metadataPath)).mtimeMs).toBe(9e11);

    // A usage change appends exactly one more line.
    await store.writeMetadata({
      pendingOperations: [pendingOp],
      tokenUsage: USAGE_TWO,
    });
    const lines = fs.readFileSync(sidecarPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(defined(lines[1]))).toHaveProperty("usage", USAGE_TWO);
    const loaded = await (await createOptimizedContextStore(dir)).load();
    expect(loaded.tokenUsage).toEqual(USAGE_TWO);
  });

  test("the sidecar overrides a legacy metadata.json tokenUsage", async () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "metadata.json"),
      JSON.stringify({
        pendingOperations: [],
        tokenUsage: {
          input: 5,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          thinking: 0,
        },
        connectorState: null,
      }),
    );
    fs.writeFileSync(
      path.join(dir, "token-usage.jsonl"),
      `${JSON.stringify({ turnIndex: 3, usage: USAGE_ONE })}\n`,
    );
    const store = await createOptimizedContextStore(dir);
    expect((await store.load()).tokenUsage).toEqual(USAGE_ONE);
  });

  test("no sidecar falls back to the legacy metadata.json tokenUsage", async () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "metadata.json"),
      JSON.stringify({
        pendingOperations: [],
        tokenUsage: USAGE_TWO,
        connectorState: null,
      }),
    );
    const store = await createOptimizedContextStore(dir);
    expect((await store.load()).tokenUsage).toEqual(USAGE_TWO);
  });

  test("torn metadata.json does not zero a valid sidecar", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "metadata.json"), "{not-json");
    fs.writeFileSync(
      path.join(dir, "token-usage.jsonl"),
      `${JSON.stringify({ turnIndex: 1, usage: USAGE_ONE })}\n`,
    );
    const store = await createOptimizedContextStore(dir);
    const loaded = await store.load();
    expect(loaded.tokenUsage).toEqual(USAGE_ONE);
    expect(loaded.tokenUsage.input).toBe(10);
    expect(loaded.pendingOperations).toEqual([]);
    expect(loaded.connectorState).toBeNull();
  });

  test("a torn last sidecar line drops and the prior record survives", async () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "token-usage.jsonl"),
      `${JSON.stringify({ turnIndex: 1, usage: USAGE_ONE })}\n` +
        '{"turnIndex":2,"usage":{"input":',
    );
    const store = await createOptimizedContextStore(dir);
    expect((await store.load()).tokenUsage).toEqual(USAGE_ONE);
  });

  test("resume restore picks the sidecar state the crashed turn reached", async () => {
    const dir = tempDir();
    const storeA = await createOptimizedContextStore(dir);
    await storeA.writeTurns([turn("a")]);
    await storeA.writeMetadata({
      pendingOperations: [],
      tokenUsage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      },
    });
    await storeA.commit({ message: "base" });
    await storeA.writeTurns([turn("a"), turn("b")]);
    await storeA.writeMetadata({
      pendingOperations: [],
      tokenUsage: USAGE_TWO,
    });
    // No commit: the crash happened before the turn's git checkpoint. The
    // next store instance reads the sidecar the crash left on disk.
    await storeA.commit({ message: "unused" });

    const resumed = await createOptimizedContextStore(dir);
    expect((await resumed.load()).tokenUsage).toEqual(USAGE_TWO);
  });
});
