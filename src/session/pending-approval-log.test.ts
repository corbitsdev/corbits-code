import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import git from "isomorphic-git";

import type { ConversationTurn, PendingOperation } from "@intx/types/runtime";

import { withFileLogSink } from "../../testkit/file-log-sink.js";
import { LOG_NAMESPACE_ROOT } from "../branding.js";
import { createPruningCompactor } from "./compactor.js";
import {
  createOptimizedContextStore,
  loadRecentTurns,
} from "./optimized-context-store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-approval-log-"));
  dirs.push(dir);
  return dir;
}

const SECRET = "sk-test-0123456789abcdefghij";

const user: ConversationTurn = {
  role: "user",
  content: [{ type: "text", text: "probe" }],
  timestamp: 1,
};

const assistant: ConversationTurn = {
  role: "assistant",
  content: [
    {
      type: "tool_call",
      id: "call-1",
      name: "run_shell",
      arguments: { api_key: SECRET },
    },
    {
      type: "tool_call",
      id: "call-2",
      name: "read_file",
      arguments: { path: "a" },
    },
  ],
  timestamp: 2,
};

function resultTurn(callId: string, timestamp: number): ConversationTurn {
  return {
    role: "user",
    content: [
      { type: "tool_result", callId, content: [{ type: "text", text: "ok" }] },
    ],
    timestamp,
  };
}

const siblingResult = resultTurn("call-2", 3);

function approvalFor(
  callId: string,
  args: Record<string, unknown>,
): PendingOperation {
  return {
    correlationId: `corr-${callId}`,
    kind: "approval",
    registeredAt: 1_700_000_000_000,
    gateId: `pending-corr-${callId}`,
    timeoutAt: 1_700_003_600_000,
    suspendedCall: { id: callId, name: "run_shell", arguments: args },
    approvalSnapshot: {
      name: "run_shell",
      description: "runs a shell command",
      inputSchema: {},
      arguments: args,
    },
  };
}

const op = approvalFor("call-1", { api_key: SECRET });
const answered = resultTurn("call-1", 4);

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };

type LogLine = Record<string, unknown>;

function logLines(dir: string): LogLine[] {
  return fs
    .readFileSync(path.join(dir, "turns.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LogLine);
}

function lineKinds(dir: string): string[] {
  return logLines(dir).map((line) => ("role" in line ? "turn" : "record"));
}

function recordedApprovals(dir: string): PendingOperation[] {
  return logLines(dir).flatMap((line) =>
    "pendingApproval" in line ? [line.pendingApproval as PendingOperation] : [],
  );
}

function metadataPath(dir: string): string {
  return path.join(dir, "metadata.json");
}

async function headPaths(dir: string): Promise<string[]> {
  return git.listFiles({ fs, dir, ref: "HEAD" });
}

async function openOps(dir: string): Promise<string[]> {
  const loaded = await (await createOptimizedContextStore(dir)).load();
  return loaded.pendingOperations.map((pending) => pending.correlationId);
}

async function parkCall(
  dir: string,
  turns: ConversationTurn[],
  ops: PendingOperation[],
) {
  const store = await createOptimizedContextStore(dir);
  await store.writeTurns(turns);
  await store.writeMetadata({ pendingOperations: ops, tokenUsage: USAGE });
  const commit = await store.commit({ message: "suspend" });
  return { store, commit };
}

// Forces the next commit to fail: every object write hits ENOTDIR.
async function failingCommit(dir: string, run: () => Promise<unknown>) {
  const objectsDir = path.join(dir, ".git", "objects");
  const held = `${objectsDir}.held`;
  fs.renameSync(objectsDir, held);
  fs.writeFileSync(objectsDir, "held");
  try {
    await expect(run()).rejects.toThrow();
  } finally {
    fs.unlinkSync(objectsDir);
    fs.renameSync(held, objectsDir);
  }
}

function textTurn(text: string): ConversationTurn {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function readCall(id: string): ConversationTurn {
  return {
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
  };
}

function readResult(id: string, text: string): ConversationTurn {
  return {
    role: "user",
    content: [
      { type: "tool_result", callId: id, content: [{ type: "text", text }] },
    ],
    timestamp: 1,
  };
}

// Enough tool history for the pruning compactor to fold, ending on a parked
// call it must keep.
function longHistoryEndingParked(): ConversationTurn[] {
  return [
    textTurn("start the migration and keep the auth notes"),
    textTurn("constraint: do not rewrite the session log"),
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
    assistant,
    siblingResult,
  ];
}

function callIds(turns: readonly ConversationTurn[]): string[] {
  return turns.flatMap((candidate) =>
    candidate.content.flatMap((block) =>
      block.type === "tool_call" ? [block.id] : [],
    ),
  );
}

/** Index of the turn line holding `callId`, and of the record for it. */
function recordFollowsCall(dir: string, callId: string): boolean {
  const lines = logLines(dir);
  const callAt = lines.findIndex(
    (line) =>
      Array.isArray(line.content) &&
      (line.content as { type: string; id?: string }[]).some(
        (block) => block.type === "tool_call" && block.id === callId,
      ),
  );
  const next = lines[callAt + 1];
  return (
    callAt >= 0 &&
    next !== undefined &&
    "pendingApproval" in next &&
    (next.pendingApproval as PendingOperation).suspendedCall?.id === callId
  );
}

function jsonl(records: readonly unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

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

describe("approval records in the turn log", () => {
  test("load, readAt, and the recent window read them as no turn, without warnings", async () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "turns.jsonl"),
      jsonl([user, assistant, { pendingApproval: op }]),
    );
    fs.writeFileSync(
      path.join(dir, "turns-0001.jsonl"),
      jsonl([siblingResult]),
    );
    const writer = await createOptimizedContextStore(dir);
    const commit = await writer.commit({ message: "hand-written log" });

    let loaded: ConversationTurn[] = [];
    let atCommit: ConversationTurn[] = [];
    let recent: ConversationTurn[] = [];
    const logged = await withFileLogSink(async () => {
      const store = await createOptimizedContextStore(dir);
      loaded = (await store.load()).turns;
      atCommit = await store.readAt(commit.hash);
      recent = (await loadRecentTurns(dir, 10)).turns;
    });

    const history = [user, assistant, siblingResult];
    expect(contextStoreWarnings(logged)).toEqual([]);
    expect(loaded).toEqual(history);
    expect(atCommit).toEqual(history);
    expect(recent).toEqual(history);
  });
});

describe("a parked approval in the turn log", () => {
  test("writeTurns stages the parked call and writeMetadata flushes it once", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    await store.writeTurns([user, assistant]);
    expect(fs.existsSync(path.join(dir, "turns.jsonl"))).toBe(false);

    await store.writeMetadata({ pendingOperations: [op], tokenUsage: USAGE });
    expect(lineKinds(dir)).toEqual(["turn", "turn", "record"]);
    expect(fs.existsSync(metadataPath(dir))).toBe(false);
    const flushed = fs.readFileSync(path.join(dir, "turns.jsonl"));

    await store.commit({ message: "suspend" });
    expect(fs.readFileSync(path.join(dir, "turns.jsonl"))).toEqual(flushed);
    expect(await openOps(dir)).toEqual([op.correlationId]);
  });

  test("the suspend commit writes it right after its call, snapshot scrubbed, and no metadata.json", async () => {
    const dir = tempDir();
    await parkCall(dir, [user, assistant], [op]);

    expect(lineKinds(dir)).toEqual(["turn", "turn", "record"]);
    const [record] = recordedApprovals(dir);
    expect(record?.correlationId).toBe(op.correlationId);
    expect(record?.timeoutAt).toBe(op.timeoutAt);
    // The approver-facing snapshot is redacted at rest; the re-dispatch
    // artifact stays raw, same as the call block it parks.
    expect(JSON.stringify(record?.approvalSnapshot)).not.toContain(SECRET);
    expect(record?.suspendedCall?.arguments).toEqual({ api_key: SECRET });
    expect(fs.existsSync(metadataPath(dir))).toBe(false);

    const loaded = await (await createOptimizedContextStore(dir)).load();
    expect(loaded.turns).toEqual([user, assistant]);
    expect(loaded.pendingOperations).toHaveLength(1);
    expect(loaded.pendingOperations[0]?.suspendedCall?.arguments).toEqual({
      api_key: SECRET,
    });
    expect(loaded.pendingOperations[0]?.timeoutAt).toBe(op.timeoutAt);
  });

  test("the call's tool_result closes it with no metadata write or commit", async () => {
    const dir = tempDir();
    const { store } = await parkCall(dir, [user, assistant], [op]);
    // Sibling results land after the batch: the parked call is still open.
    await store.writeTurns([user, assistant, siblingResult]);
    expect(await openOps(dir)).toEqual([op.correlationId]);

    // Approved: the reactor drops the op in memory and the tool cycle writes
    // turns only, then the process goes away before any commit.
    await store.writeTurns([user, assistant, siblingResult, answered]);
    expect(await openOps(dir)).toEqual([]);
    // Append-only: the record kept its line, later turns follow it.
    expect(lineKinds(dir)).toEqual(["turn", "turn", "record", "turn", "turn"]);
  });

  test("a fresh writer after a restart keeps it on its first rewrite", async () => {
    const dir = tempDir();
    await parkCall(dir, [user, assistant], [op]);

    const second = await createOptimizedContextStore(dir);
    const loaded = await second.load();
    await second.writeTurns([...loaded.turns, siblingResult]);
    await second.writeMetadata({
      pendingOperations: loaded.pendingOperations,
      tokenUsage: USAGE,
    });
    await second.commit({ message: "siblings" });

    expect(lineKinds(dir)).toEqual(["turn", "turn", "record", "turn"]);
    expect(await openOps(dir)).toEqual([op.correlationId]);
  });

  test("a torn record line is dropped like any torn tail", async () => {
    const dir = tempDir();
    const whole = JSON.stringify({ pendingApproval: op });
    fs.writeFileSync(
      path.join(dir, "turns.jsonl"),
      jsonl([user, assistant]) + whole.slice(0, whole.length / 2),
    );

    const store = await createOptimizedContextStore(dir);
    const loaded = await store.load();
    expect(loaded.turns).toEqual([user, assistant]);
    expect(loaded.pendingOperations).toEqual([]);
    await store.writeTurns([...loaded.turns, siblingResult]);
    expect(lineKinds(dir)).toEqual(["turn", "turn", "turn"]);
  });

  test("in a parallel batch, answering one parked call leaves only the other open", async () => {
    const dir = tempDir();
    const second = approvalFor("call-2", { path: "a" });
    second.suspendedCall = {
      id: "call-2",
      name: "read_file",
      arguments: { path: "a" },
    };
    const { store } = await parkCall(dir, [user, assistant], [op, second]);
    expect(lineKinds(dir)).toEqual(["turn", "turn", "record", "record"]);
    expect(await openOps(dir)).toEqual([
      op.correlationId,
      second.correlationId,
    ]);

    await store.writeTurns([user, assistant, answered]);
    await store.writeMetadata({
      pendingOperations: [second],
      tokenUsage: USAGE,
    });
    await store.commit({ message: "first answered" });

    expect(await openOps(dir)).toEqual([second.correlationId]);
    expect(fs.existsSync(metadataPath(dir))).toBe(false);
  });

  test("an async marker with no parked call stays on metadata.json", async () => {
    const dir = tempDir();
    const marker: PendingOperation = {
      correlationId: "corr-async",
      kind: "approval",
      registeredAt: 1,
      gateId: "gate-async",
    };
    await parkCall(dir, [user, assistant], [op, marker]);

    expect(recordedApprovals(dir).map((r) => r.correlationId)).toEqual([
      op.correlationId,
    ]);
    const metadata = JSON.parse(fs.readFileSync(metadataPath(dir), "utf8")) as {
      pendingOperations: PendingOperation[];
    };
    expect(metadata.pendingOperations).toEqual([marker]);
    expect(await openOps(dir)).toEqual([
      op.correlationId,
      marker.correlationId,
    ]);
  });
});

describe("a parked approval across a compaction", () => {
  for (const writer of ["same writer", "fresh writer"] as const) {
    test(`a ${writer} rewrite keeps the parked call and its record together`, async () => {
      const dir = tempDir();
      const original = longHistoryEndingParked();
      const parked = await parkCall(dir, original, [op]);
      const folded = (
        await createPruningCompactor().apply(original, {} as never)
      ).output;
      // The compactor must keep a parked call: dropping it would orphan the
      // approval regardless of where the approval is stored.
      expect(folded.length).toBeLessThan(original.length);
      expect(callIds(folded)).toContain("call-1");

      const store =
        writer === "same writer"
          ? parked.store
          : await createOptimizedContextStore(dir);
      if (writer === "fresh writer") await store.load();
      await store.writeTurns(folded);
      await store.writeMetadata({
        pendingOperations: [op],
        tokenUsage: USAGE,
      });
      await store.commit({ message: "compact" });

      expect(recordFollowsCall(dir, "call-1")).toBe(true);
      expect(recordedApprovals(dir)).toHaveLength(1);
      const loaded = await (await createOptimizedContextStore(dir)).load();
      expect(loaded.turns).toEqual(folded);
      expect(loaded.pendingOperations.map((p) => p.correlationId)).toEqual([
        op.correlationId,
      ]);
    });
  }

  test("a failed compaction commit neither loses nor duplicates the parked approval", async () => {
    const dir = tempDir();
    const original = longHistoryEndingParked();
    const { store } = await parkCall(dir, original, [op]);
    const folded = (await createPruningCompactor().apply(original, {} as never))
      .output;

    await store.writeTurns(folded);
    await store.writeMetadata({ pendingOperations: [op], tokenUsage: USAGE });
    await failingCommit(dir, () => store.commit({ message: "compact" }));

    expect(recordedApprovals(dir)).toHaveLength(1);
    expect(await openOps(dir)).toEqual([op.correlationId]);
    expect((await store.load()).pendingOperations).toHaveLength(1);
    // The next cycle's metadata write still finds the approval logged.
    await store.writeMetadata({ pendingOperations: [op], tokenUsage: USAGE });
    expect(fs.existsSync(metadataPath(dir))).toBe(false);

    await store.commit({ message: "retry compact" });
    expect(recordFollowsCall(dir, "call-1")).toBe(true);
    expect(recordedApprovals(dir)).toHaveLength(1);
    expect(await openOps(dir)).toEqual([op.correlationId]);
  });

  test("an approval parked while a rewrite is staged survives that rewrite's failed commit", async () => {
    const dir = tempDir();
    const original = longHistoryEndingParked();
    const { store } = await parkCall(dir, original, []);
    const folded = (await createPruningCompactor().apply(original, {} as never))
      .output;

    await store.writeTurns(folded);
    await store.writeMetadata({ pendingOperations: [op], tokenUsage: USAGE });
    // The rewrite is still unpublished. The approval is not on metadata.json;
    // it rides the staged rewrite and lands when that commit flushes.
    expect(recordedApprovals(dir)).toEqual([]);
    expect(fs.existsSync(metadataPath(dir))).toBe(false);
    await failingCommit(dir, () => store.commit({ message: "compact" }));

    expect(recordedApprovals(dir)).toEqual([]);
    expect(await openOps(dir)).toEqual([]);

    await store.commit({ message: "retry compact" });
    expect(recordFollowsCall(dir, "call-1")).toBe(true);
    expect(await openOps(dir)).toEqual([op.correlationId]);
    expect(fs.existsSync(metadataPath(dir))).toBe(false);
    expect(await headPaths(dir)).not.toContain("metadata.json");
  });
});

describe("a pending approval left on a legacy metadata.json", () => {
  async function legacySession(turns: ConversationTurn[]): Promise<string> {
    const dir = tempDir();
    const seed = await createOptimizedContextStore(dir);
    await seed.writeTurns(turns);
    fs.writeFileSync(
      metadataPath(dir),
      JSON.stringify({ pendingOperations: [op], connectorState: null }),
    );
    await seed.commit({ message: "legacy" });
    expect(await headPaths(dir)).toContain("metadata.json");
    return dir;
  }

  test("an open one loads, then moves into the log and the file leaves the commit", async () => {
    const dir = await legacySession([user, assistant]);

    const store = await createOptimizedContextStore(dir);
    const loaded = await store.load();
    expect(loaded.pendingOperations.map((p) => p.correlationId)).toEqual([
      op.correlationId,
    ]);
    await store.writeTurns([...loaded.turns, siblingResult]);
    await store.writeMetadata({
      pendingOperations: loaded.pendingOperations,
      tokenUsage: USAGE,
    });
    await store.commit({ message: "migrate" });

    expect(recordFollowsCall(dir, "call-1")).toBe(true);
    expect(fs.existsSync(metadataPath(dir))).toBe(false);
    expect(await headPaths(dir)).not.toContain("metadata.json");
    expect(await openOps(dir)).toEqual([op.correlationId]);
  });

  test("one whose call is answered does not re-arm", async () => {
    const dir = await legacySession([user, assistant, siblingResult, answered]);
    expect(await openOps(dir)).toEqual([]);
  });

  test("one whose call is not in history does not re-arm", async () => {
    const dir = await legacySession([user]);
    expect(await openOps(dir)).toEqual([]);
  });

  test("a closed log record does not tombstone an open op with the same correlationId", async () => {
    const dir = tempDir();
    const closed = {
      pendingApproval: {
        ...op,
        suspendedCall: {
          id: "gone",
          name: "run_shell",
          arguments: { api_key: SECRET },
        },
      },
    };
    fs.writeFileSync(
      path.join(dir, "turns.jsonl"),
      jsonl([user, assistant, closed]),
    );
    fs.writeFileSync(
      metadataPath(dir),
      JSON.stringify({ pendingOperations: [op], connectorState: null }),
    );

    const loaded = await (await createOptimizedContextStore(dir)).load();
    expect(callIds(loaded.turns)).toContain("call-1");
    expect(
      loaded.pendingOperations.map((pending) => pending.correlationId),
    ).toEqual([op.correlationId]);
  });

  test("an answered call stays closed when metadata.json still lists the logged approval", async () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "turns.jsonl"),
      jsonl([
        user,
        assistant,
        siblingResult,
        { pendingApproval: op },
        answered,
      ]),
    );
    fs.writeFileSync(
      metadataPath(dir),
      JSON.stringify({ pendingOperations: [op], connectorState: null }),
    );
    expect(await openOps(dir)).toEqual([]);
  });
});

describe("a parked approval must be the historical tool call", () => {
  test("a suspendedCall whose body differs from the unanswered tool_call is not open", async () => {
    const dir = tempDir();
    const parked: ConversationTurn = {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "call-1",
          name: "run_shell",
          arguments: { cmd: "true" },
        },
      ],
      timestamp: 2,
    };
    const mismatched = {
      pendingApproval: {
        ...op,
        suspendedCall: {
          id: "call-1",
          name: "run_shell",
          arguments: { cmd: "false" },
        },
      },
    };
    fs.writeFileSync(
      path.join(dir, "turns.jsonl"),
      jsonl([user, parked, mismatched]),
    );

    const loaded = await (await createOptimizedContextStore(dir)).load();
    expect(callIds(loaded.turns)).toContain("call-1");
    expect(loaded.pendingOperations).toEqual([]);
  });
});
