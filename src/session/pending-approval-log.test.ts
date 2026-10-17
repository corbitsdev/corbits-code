import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ConversationTurn, PendingOperation } from "@intx/types/runtime";

import { withFileLogSink } from "../../testkit/file-log-sink.js";
import { LOG_NAMESPACE_ROOT } from "../branding.js";
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
