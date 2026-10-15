import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SendResult } from "@intx/agent";
import type { PendingOperation } from "@intx/types/runtime";

import { resolveSuspendedApprovalFromStore } from "./approval-resume.js";
import { createOptimizedContextStore } from "./optimized-context-store.js";
import { scrubPersistedPendingOperations } from "./pending-snapshot-scrub.js";

const SECRET = "sk-proj-0123456789abcdefghij0123";

function approvalOp(args: Record<string, unknown>): PendingOperation {
  return {
    correlationId: "corr-1",
    kind: "approval",
    registeredAt: 1,
    gateId: "gate-1",
    suspendedCall: { id: "call-1", name: "run_shell", arguments: args },
    approvalSnapshot: {
      name: "run_shell",
      description: "runs a shell command",
      inputSchema: {},
      arguments: args,
    },
  };
}

describe("scrubPersistedPendingOperations", () => {
  test("redacts credential-shaped snapshot args while suspendedCall stays raw", () => {
    const [op] = scrubPersistedPendingOperations([
      approvalOp({ api_key: SECRET, mode: "fast" }),
    ]);
    expect(op).toBeDefined();
    expect(JSON.stringify(op?.approvalSnapshot?.arguments)).not.toContain(
      SECRET,
    );
    expect(op?.approvalSnapshot?.arguments.mode).toBe("fast");
    // The re-dispatch artifact keeps the live arguments untouched.
    expect(op?.suspendedCall?.arguments).toEqual({
      api_key: SECRET,
      mode: "fast",
    });
    // The live in-memory object handed in is not mutated.
    expect(op?.approvalSnapshot?.arguments.api_key === SECRET).toBe(false);
  });

  test("nested credential shapes deep inside args are redacted too", () => {
    const [op] = scrubPersistedPendingOperations([
      approvalOp({ body: { Authorization: `Bearer ${SECRET}` } }),
    ]);
    expect(JSON.stringify(op?.approvalSnapshot)).not.toContain(SECRET);
  });

  test("ops without snapshots pass through untouched", () => {
    const noSnapshot: PendingOperation = {
      correlationId: "corr-2",
      kind: "approval",
      registeredAt: 1,
      gateId: "gate-2",
    };
    const out = scrubPersistedPendingOperations([noSnapshot]);
    expect(out[0]).toBe(noSnapshot);
  });

  test("non-JSON-safe args fail closed with no unscrubbed value persisted", () => {
    const args = { api_key: SECRET, nested: new Map([["x", SECRET]]) };
    const [op] = scrubPersistedPendingOperations([approvalOp(args)]);
    expect(JSON.stringify(op?.approvalSnapshot?.arguments)).not.toContain(
      SECRET,
    );
    expect(JSON.stringify(op?.approvalSnapshot).length).toBeGreaterThan(0);
  });

  test("a secret-carrying parked approval still resumes from the scrubbed store", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-resume-"));
    const store = await createOptimizedContextStore(dir);
    const args = { api_key: SECRET, mode: "fast" };
    const op: PendingOperation = {
      correlationId: "corr-9",
      kind: "approval",
      registeredAt: 1_700_000_000_000,
      gateId: "gate-9",
      timeoutAt: Date.now() + 60_000,
      suspendedCall: { id: "call-9", name: "run_shell", arguments: args },
      approvalSnapshot: {
        name: "run_shell",
        description: "runs a shell command",
        inputSchema: {},
        arguments: args,
      },
    };
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

    // Redacted at rest ...
    const persistedArgs = JSON.stringify(
      (
        JSON.parse(
          fs.readFileSync(path.join(dir, "metadata.json"), "utf8"),
        ) as {
          pendingOperations: { approvalSnapshot: { arguments: object } }[];
        }
      ).pendingOperations[0]?.approvalSnapshot?.arguments,
    );
    expect(persistedArgs).not.toContain(SECRET);

    // ... yet the stalled-approval recovery still proves the live suspended
    // result against the persisted (scrubbed) snapshot: same canonical scrub
    // on both sides of the comparison.
    const resolution = await resolveSuspendedApprovalFromStore(
      { load: () => store.load() },
      {
        type: "suspended",
        correlationId: "corr-9",
        approvalSnapshot: op.approvalSnapshot,
      } as Extract<SendResult, { type: "suspended" }>,
    );
    expect(resolution).toEqual({ ok: true, parkedCallId: "call-9" });

    // A genuinely different call still fails closed: benign-arg drift is
    // catchable through the same canonical transform.
    const drifted = await resolveSuspendedApprovalFromStore(
      { load: () => store.load() },
      {
        type: "suspended",
        correlationId: "corr-9",
        approvalSnapshot: {
          ...op.approvalSnapshot,
          arguments: { ...args, mode: "slow" },
        },
      } as Extract<SendResult, { type: "suspended" }>,
    );
    expect(drifted).toEqual({ ok: false, code: "snapshot-mismatch" });
  });

  test("a swapped credential in the re-dispatch payload is a snapshot mismatch", async () => {
    const keyA = "sk-proj-aaaaaaaaaaaaaaaaaaaa";
    const keyB = "sk-proj-bbbbbbbbbbbbbbbbbbbb";
    const parkedArgs = { api_key: keyA, mode: "fast" };
    const swappedArgs = { api_key: keyB, mode: "fast" };
    const op: PendingOperation = {
      correlationId: "corr-9",
      kind: "approval",
      registeredAt: 1_700_000_000_000,
      gateId: "gate-9",
      timeoutAt: Date.now() + 60_000,
      suspendedCall: { id: "call-9", name: "run_shell", arguments: parkedArgs },
      approvalSnapshot: {
        name: "run_shell",
        description: "runs a shell command",
        inputSchema: {},
        arguments: swappedArgs,
      },
    };
    const swapped = await resolveSuspendedApprovalFromStore(
      {
        load: async () => ({
          turns: [],
          pendingOperations: [op],
          tokenUsage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            thinking: 0,
          },
          connectorState: null,
        }),
      },
      {
        type: "suspended",
        correlationId: "corr-9",
        approvalSnapshot: op.approvalSnapshot,
      } as Extract<SendResult, { type: "suspended" }>,
    );
    expect(swapped).toEqual({ ok: false, code: "snapshot-mismatch" });
  });
});
