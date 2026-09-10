import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InboundMessage } from "@intx/types/runtime";
import { base64Encode } from "@intx/types";
import { createInboundTurn } from "@intx/inference";
import { CREDENTIAL_REDACTION } from "../plugins/tool-result-secret-scrub.js";
import {
  admitPrimaryInboundMessage,
  applyRecordingPolicyToText,
  applyRecordingPolicyToValue,
  authorizedToolArgsRepresentation,
  createCompactionArchive,
  createPrimaryDeliveryAdmission,
  hashAuthorizedBytes,
  isControlOrEmptyInbound,
} from "./compaction-archive.js";
import { createOptimizedContextStore } from "./optimized-context-store.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "compaction-archive-"));
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected ${label}`);
  return value;
}

function inbound(
  partial: Partial<InboundMessage> & { content?: string },
): InboundMessage {
  return {
    ref: { uid: 1, mailbox: "INBOX" },
    headers: {
      from: "user@local",
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: `<${crypto.randomUUID()}@local>`,
      interchangeType: "conversation.message",
      ...partial.headers,
    },
    flags: [],
    signatureStatus: "missing",
    content: partial.content ?? "",
    ...(partial.attachments !== undefined
      ? { attachments: partial.attachments }
      : {}),
    ...(partial.ref !== undefined ? { ref: partial.ref } : {}),
  };
}

describe("recording policy", () => {
  test("scrubs secret-shaped text without inventing a second policy", () => {
    const text = "token sk-abcdefghijklmnopqrstuvwxyz012345";
    const out = applyRecordingPolicyToText(text);
    expect(out).toContain(CREDENTIAL_REDACTION);
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
  });

  test("structure-preserving redact keeps object shape", () => {
    const input = {
      ok: true,
      nested: { api_key: "sk-abcdefghijklmnopqrstuvwxyz012345", count: 2 },
      list: ["safe", "Bearer abcdefghijklmnopqrstuvwxyz012345"],
    };
    const out = applyRecordingPolicyToValue(input);
    expect(out).toEqual({
      ok: true,
      nested: { api_key: CREDENTIAL_REDACTION, count: 2 },
      list: ["safe", CREDENTIAL_REDACTION],
    });
    expect(input.nested.api_key).toBe("sk-abcdefghijklmnopqrstuvwxyz012345");
  });

  test("authorized tool args representation does not mutate execution args", () => {
    const args = {
      command:
        "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345' https://x",
    };
    const recorded = authorizedToolArgsRepresentation(args);
    expect(recorded.command).toContain(CREDENTIAL_REDACTION);
    expect(args.command).toContain("Bearer abcdefghijklmnopqrstuvwxyz012345");
  });
});

describe("primary message admission", () => {
  test("admits scrubbed text that becomes the history representation", () => {
    const message = inbound({
      content: "use sk-abcdefghijklmnopqrstuvwxyz012345 carefully",
    });
    const admitted = admitPrimaryInboundMessage(message);
    expect(admitted.content).toContain(CREDENTIAL_REDACTION);
    expect(admitted.content).not.toContain(
      "sk-abcdefghijklmnopqrstuvwxyz012345",
    );
    expect(message.content).toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
  });

  test("preserves empty continuation and control payloads", () => {
    const empty = inbound({ content: "" });
    expect(isControlOrEmptyInbound(empty)).toBe(true);
    expect(admitPrimaryInboundMessage(empty).content).toBe("");

    const approval = inbound({
      content: JSON.stringify({ outcome: "approved" }),
      ref: { uid: 0, mailbox: "approval" },
      headers: {
        from: "approval@local",
        to: ["agent@local"],
        date: new Date().toISOString(),
        messageId: "approval-corr-1",
        interchangeCorrelationId: "corr-1",
      },
    });
    expect(isControlOrEmptyInbound(approval)).toBe(true);
    const admitted = admitPrimaryInboundMessage(approval);
    expect(admitted.content).toBe(approval.content);
    expect(admitted.headers.interchangeCorrelationId).toBe("corr-1");
  });

  test("does not scrub binary attachment payloads", () => {
    const bytes = new TextEncoder().encode(
      "sk-abcdefghijklmnopqrstuvwxyz012345",
    );
    const message = inbound({
      content: "see image",
      attachments: [{ name: "a.png", contentType: "image/png", data: bytes }],
    });
    const admitted = admitPrimaryInboundMessage(message);
    expect(admitted.attachments?.[0]?.data).toEqual(bytes);
    expect(admitted.content).toBe("see image");
  });

  test("delivery wrapper admits before deliver/send", async () => {
    const delivered: InboundMessage[] = [];
    const agent = {
      deliver(message: InboundMessage) {
        delivered.push(message);
      },
      async send(content: string | InboundMessage) {
        if (typeof content === "string") {
          delivered.push(inbound({ content }));
          return { ok: true as const };
        }
        delivered.push(content);
        return { ok: true as const };
      },
    };
    const wrapped = createPrimaryDeliveryAdmission(agent);
    wrapped.deliver(
      inbound({ content: "leak sk-abcdefghijklmnopqrstuvwxyz012345" }),
    );
    await wrapped.send(
      inbound({ content: "also sk-abcdefghijklmnopqrstuvwxyz012345" }),
    );
    expect(delivered).toHaveLength(2);
    expect(required(delivered[0], "first delivery").content).toContain(
      CREDENTIAL_REDACTION,
    );
    expect(required(delivered[1], "second delivery").content).toContain(
      CREDENTIAL_REDACTION,
    );
  });

  test("history and archive share the same admitted representation", async () => {
    const dir = tempDir();
    const blobs = new Map<string, Uint8Array>();
    const archive = createCompactionArchive({
      sessionId: "sess-admit",
      contextDir: dir,
      writeBlob: async (key, bytes) => {
        blobs.set(key, bytes);
      },
      readBlob: async (key) => {
        const bytes = blobs.get(key);
        if (bytes === undefined) throw new Error(`missing blob ${key}`);
        return bytes;
      },
    });
    const delivered: InboundMessage[] = [];
    const agent = {
      deliver(message: InboundMessage) {
        delivered.push(message);
      },
      async send(content: string | InboundMessage) {
        if (typeof content === "string") {
          delivered.push(inbound({ content }));
          return { ok: true as const };
        }
        delivered.push(content);
        return { ok: true as const };
      },
    };
    const wrapped = createPrimaryDeliveryAdmission(agent, archive);
    wrapped.deliver(
      inbound({ content: "constraint sk-abcdefghijklmnopqrstuvwxyz012345" }),
    );
    await archive.awaitPendingWrites();
    expect(delivered).toHaveLength(1);
    const admitted = required(
      required(delivered[0], "first delivery").content,
      "admitted content",
    );
    expect(admitted).toContain(CREDENTIAL_REDACTION);
    expect(admitted).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    const occurrences = await archive.listOccurrences();
    expect(occurrences).toHaveLength(1);
    expect(required(occurrences[0], "occurrence").kind).toBe("user_message");
    const archived = await archive.readAuthorizedPayload(
      required(occurrences[0], "occurrence").occurrenceId,
    );
    const history = createInboundTurn(required(delivered[0], "first delivery"));
    const historyText = history?.content.find((block) => block.type === "text");
    expect(historyText?.type === "text" ? historyText.text : undefined).toBe(
      archived,
    );
    expect(archived.startsWith("[From: user@local]\n\n")).toBe(true);
    expect(archived.endsWith(admitted)).toBe(true);
  });

  test("send(string) admits and archives like InboundMessage", async () => {
    const dir = tempDir();
    const blobs = new Map<string, Uint8Array>();
    const archive = createCompactionArchive({
      sessionId: "sess-send-string",
      contextDir: dir,
      writeBlob: async (key, bytes) => {
        blobs.set(key, bytes);
      },
      readBlob: async (key) => {
        const bytes = blobs.get(key);
        if (bytes === undefined) throw new Error(`missing blob ${key}`);
        return bytes;
      },
    });
    const sent: string[] = [];
    const agent = {
      deliver(_message: InboundMessage) {
        /* unused */
      },
      async send(content: string | InboundMessage) {
        if (typeof content !== "string")
          throw new Error("expected string send");
        sent.push(content);
        return { ok: true as const };
      },
    };
    const wrapped = createPrimaryDeliveryAdmission(agent, archive);
    const secret = `sk-${"a".repeat(24)}`;
    await wrapped.send(`constraint ${secret}`);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(CREDENTIAL_REDACTION);
    expect(sent[0]).not.toContain(secret);
    const occurrences = await archive.listOccurrences();
    expect(occurrences).toHaveLength(1);
    expect(
      await archive.readAuthorizedPayload(
        required(occurrences[0], "occurrence").occurrenceId,
      ),
    ).toBe(`[From: user@local]\n\n${required(sent[0], "sent")}`);
  });
});

describe("compaction archive storage", () => {
  test("round-trips exact authorized payloads and refuses incomplete certificates", async () => {
    const dir = tempDir();
    const blobs = new Map<string, Uint8Array>();
    const archive = createCompactionArchive({
      sessionId: "sess-a",
      contextDir: dir,
      writeBlob: async (key, bytes) => {
        blobs.set(key, bytes);
      },
      readBlob: async (key) => {
        const bytes = blobs.get(key);
        if (bytes === undefined) throw new Error(`missing blob ${key}`);
        return bytes;
      },
    });

    const authorized = applyRecordingPolicyToText(
      "constraint west with sk-abcdefghijklmnopqrstuvwxyz012345",
    );
    const userOcc = await archive.recordAuthorizedPayload({
      kind: "user_message",
      payload: authorized,
    });
    const assistantOcc = await archive.recordAuthorizedPayload({
      kind: "assistant_text",
      payload: applyRecordingPolicyToText("ack west"),
    });

    const oversized = "decisive-fact-42\n" + "x".repeat(12_000);
    const scrubbedOversized = applyRecordingPolicyToText(oversized);
    const resultOcc = await archive.recordAuthorizedPayload({
      kind: "tool_result",
      payload: scrubbedOversized,
      callId: "call-1",
    });

    const loaded = await archive.readAuthorizedPayload(userOcc.occurrenceId);
    expect(loaded).toBe(authorized);
    expect(loaded).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");

    const complete = await archive.certifyRange([
      userOcc.occurrenceId,
      assistantOcc.occurrenceId,
      resultOcc.occurrenceId,
    ]);
    expect(complete.status).toBe("complete");
    expect(complete.missingOccurrenceIds).toEqual([]);
    expect(complete.unverifiedBlobIds).toEqual([]);

    const incomplete = await archive.certifyRange([
      userOcc.occurrenceId,
      "occ-missing-historical",
      resultOcc.occurrenceId,
    ]);
    expect(incomplete.status).toBe("incomplete");
    expect(incomplete.missingOccurrenceIds).toEqual(["occ-missing-historical"]);
  });

  test("isolates callIds across sessions and verifies blob hashes", async () => {
    const dir = tempDir();
    const blobs = new Map<string, { session: string; bytes: Uint8Array }>();

    const make = (sessionId: string) =>
      createCompactionArchive({
        sessionId,
        contextDir: path.join(dir, sessionId),
        writeBlob: async (key, bytes) => {
          blobs.set(`${sessionId}:${key}`, { session: sessionId, bytes });
        },
        readBlob: async (key) => {
          const hit = blobs.get(`${sessionId}:${key}`);
          if (hit === undefined) throw new Error(`missing ${sessionId}:${key}`);
          return hit.bytes;
        },
      });

    const a = make("sess-a");
    const b = make("sess-b");
    const occA = await a.recordAuthorizedPayload({
      kind: "tool_result",
      payload: "from-a",
      callId: "shared-call",
    });
    const occB = await b.recordAuthorizedPayload({
      kind: "tool_result",
      payload: "from-b",
      callId: "shared-call",
    });
    expect(occA.blobKey).not.toBe(occB.blobKey);
    expect(occA.occurrenceId).not.toBe(occB.occurrenceId);
    expect(await a.readAuthorizedPayload(occA.occurrenceId)).toBe("from-a");
    expect(await b.readAuthorizedPayload(occB.occurrenceId)).toBe("from-b");

    // Corrupt blob bytes after write — certificate must fail verification.
    const stored = blobs.get(`sess-a:${occA.blobKey}`);
    if (stored === undefined) throw new Error("expected stored blob");
    stored.bytes = new TextEncoder().encode("tampered");
    const cert = await a.certifyRange([occA.occurrenceId]);
    expect(cert.status).toBe("incomplete");
    expect(cert.unverifiedBlobIds).toEqual([occA.occurrenceId]);
  });

  test("tool lifecycle records denied failure evidence without forbidden args", async () => {
    const dir = tempDir();
    const blobs = new Map<string, Uint8Array>();
    const archive = createCompactionArchive({
      sessionId: "sess-deny",
      contextDir: dir,
      writeBlob: async (key, bytes) => {
        blobs.set(key, bytes);
      },
      readBlob: async (key) => {
        const bytes = blobs.get(key);
        if (bytes === undefined) throw new Error(`missing ${key}`);
        return bytes;
      },
    });

    const forbiddenArgs = {
      command: "cat /etc/shadow",
      token: "sk-abcdefghijklmnopqrstuvwxyz012345",
    };
    await archive.noteToolRequested({
      id: "deny-1",
      name: "run_shell",
      arguments: forbiddenArgs,
    });
    const denied = await archive.finalizeToolRecording({
      callId: "deny-1",
      name: "run_shell",
      lifecycle: "denied",
      executionArgs: forbiddenArgs,
    });
    expect(denied.lifecycle).toBe("denied");
    expect(denied.kind).toBe("tool_failure");
    const payload = JSON.parse(
      await archive.readAuthorizedPayload(denied.occurrenceId),
    );
    expect(payload.lifecycle).toBe("denied");
    expect(payload.arguments.token).toBe(CREDENTIAL_REDACTION);
    expect(JSON.stringify(payload)).not.toContain(
      "sk-abcdefghijklmnopqrstuvwxyz012345",
    );
    // Execution args object remains untouched for the runner.
    expect(forbiddenArgs.token).toBe("sk-abcdefghijklmnopqrstuvwxyz012345");
  });

  test("suspended then admitted finalizes after guards resolve", async () => {
    const dir = tempDir();
    const blobs = new Map<string, Uint8Array>();
    const archive = createCompactionArchive({
      sessionId: "sess-ask",
      contextDir: dir,
      writeBlob: async (key, bytes) => {
        blobs.set(key, bytes);
      },
      readBlob: async (key) => {
        const bytes = blobs.get(key);
        if (bytes === undefined) throw new Error(`missing ${key}`);
        return bytes;
      },
    });
    const args = { path: "README.md" };
    await archive.noteToolRequested({
      id: "ask-1",
      name: "read_file",
      arguments: args,
    });
    const suspended = await archive.finalizeToolRecording({
      callId: "ask-1",
      name: "read_file",
      lifecycle: "suspended",
      executionArgs: args,
    });
    expect(suspended.lifecycle).toBe("suspended");
    const admitted = await archive.finalizeToolRecording({
      callId: "ask-1",
      name: "read_file",
      lifecycle: "admitted",
      executionArgs: args,
    });
    expect(admitted.lifecycle).toBe("admitted");
    expect(admitted.kind).toBe("tool_args");
  });

  test("reuses verified overflow/attachment blobs and marks missing explicitly", async () => {
    const dir = tempDir();
    const blobs = new Map<string, Uint8Array>();
    const archive = createCompactionArchive({
      sessionId: "sess-blob",
      contextDir: dir,
      writeBlob: async (key, bytes) => {
        blobs.set(key, bytes);
      },
      readBlob: async (key) => {
        const bytes = blobs.get(key);
        if (bytes === undefined) throw new Error(`missing ${key}`);
        return bytes;
      },
    });

    const full = new TextEncoder().encode("full-authorized-result");
    const hash = hashAuthorizedBytes(full);
    blobs.set("call-9:full", full);
    const overflow = await archive.recordExistingBlobReference({
      kind: "overflow_blob",
      blobKey: "call-9:full",
      contentHash: hash,
      callId: "call-9",
      provenance: "result-truncation:full",
    });
    expect(overflow.contentHash).toBe(hash);

    const missing = await archive.recordExistingBlobReference({
      kind: "attachment",
      blobKey: "img-missing",
      contentHash: createHash("sha256").update("nope").digest("hex"),
      provenance: "attachment-store",
    });
    expect(missing.gap).toBe(true);

    const cert = await archive.certifyRange([
      overflow.occurrenceId,
      missing.occurrenceId,
    ]);
    expect(cert.status).toBe("incomplete");
    expect(cert.unverifiedBlobIds).toContain(missing.occurrenceId);
  });

  test("bounded historical import records explicit gaps", async () => {
    const dir = tempDir();
    const blobs = new Map<string, Uint8Array>();
    const archive = createCompactionArchive({
      sessionId: "sess-import",
      contextDir: dir,
      writeBlob: async (key, bytes) => {
        blobs.set(key, bytes);
      },
      readBlob: async (key) => {
        const bytes = blobs.get(key);
        if (bytes === undefined) throw new Error(`missing ${key}`);
        return bytes;
      },
    });

    const result = await archive.importHistoricalEvidence([
      { kind: "user_message", payload: "present fact", available: true },
      {
        kind: "tool_result",
        payload: "lost",
        available: false,
        callId: "old-1",
      },
    ]);
    expect(result.importedOccurrenceIds).toHaveLength(1);
    expect(result.gapOccurrenceIds).toHaveLength(1);
    const gap = (await archive.listOccurrences()).find((o) => o.gap === true);
    expect(gap?.kind).toBe("tool_result");
    const cert = await archive.certifyRange([
      ...result.importedOccurrenceIds,
      ...result.gapOccurrenceIds,
    ]);
    expect(cert.status).toBe("incomplete");
  });

  test("awaited recording writes — certify sees committed occurrences", async () => {
    const dir = tempDir();
    let writes = 0;
    const blobs = new Map<string, Uint8Array>();
    const archive = createCompactionArchive({
      sessionId: "sess-await",
      contextDir: dir,
      writeBlob: async (key, bytes) => {
        await Bun.sleep(5);
        writes += 1;
        blobs.set(key, bytes);
      },
      readBlob: async (key) => {
        const bytes = blobs.get(key);
        if (bytes === undefined) throw new Error(`missing ${key}`);
        return bytes;
      },
    });
    const occ = await archive.recordAuthorizedPayload({
      kind: "assistant_text",
      payload: "done",
    });
    expect(writes).toBe(1);
    const cert = await archive.certifyRange([occ.occurrenceId]);
    expect(cert.status).toBe("complete");
  });

  test("recordAuthorizedPayload writes store-legal keys through createOptimizedContextStore", async () => {
    const dir = tempDir();
    const store = await createOptimizedContextStore(dir);
    const archive = createCompactionArchive({
      sessionId: "sess-store-keys",
      contextDir: dir,
      writeBlob: (key, bytes, contentType) =>
        store.writeBlob(key, bytes, contentType),
      readBlob: (key) => store.readBlob(key),
    });
    const occ = await archive.recordAuthorizedPayload({
      kind: "user_message",
      payload: "hello-store",
    });
    expect(occ.blobKey.includes("/")).toBe(false);
    expect(occ.blobKey.includes("..")).toBe(false);
    expect(await archive.readAuthorizedPayload(occ.occurrenceId)).toBe(
      "hello-store",
    );
  });

  test("rejects slash-containing blob keys so they cannot nest under tool-output", async () => {
    const dir = tempDir();
    const archive = createCompactionArchive({
      sessionId: "sess-slash",
      contextDir: dir,
      writeBlob: async () => {
        throw new Error("writeBlob must not run for a slash key");
      },
      readBlob: async () => {
        throw new Error("readBlob must not run for a slash key");
      },
    });
    let thrown: Error | undefined;
    try {
      await archive.recordExistingBlobReference({
        kind: "overflow_blob",
        blobKey: "archive/foo.json",
        contentHash: hashAuthorizedBytes(new TextEncoder().encode("x")),
      });
    } catch (cause) {
      thrown = cause instanceof Error ? cause : new Error(String(cause));
    }
    expect(thrown?.message).toContain("unsafe characters");
    expect(thrown?.message).toContain("archive/foo.json");
    expect(await archive.listOccurrences()).toEqual([]);
  });
});

describe("wrapCompactorWithCompletenessGate", () => {
  const ctx = {
    trigger: "test",
  } as unknown as import("@intx/types/runtime").StrategyContext;

  function truncating(name: string): import("@intx/types/runtime").Compactor {
    return {
      name,
      version: "1",
      async apply(turns) {
        return {
          output: turns.slice(-1),
          blobs: [
            {
              key: "stats",
              bytes: new TextEncoder().encode("{}"),
              contentType: "application/json",
            },
          ],
          record: {
            strategy: name,
            version: "1",
            parameters: {},
            reason: "compact",
            decisions: { dropped: turns.length - 1 },
          },
        };
      },
    };
  }

  function memoryArchive() {
    const dir = tempDir();
    const blobs = new Map<string, Uint8Array>();
    const archive = createCompactionArchive({
      sessionId: "sess-gate",
      contextDir: dir,
      writeBlob: async (key, bytes) => {
        blobs.set(key, bytes);
      },
      readBlob: async (key) => {
        const bytes = blobs.get(key);
        if (bytes === undefined) throw new Error(`missing ${key}`);
        return bytes;
      },
    });
    return { archive, blobs };
  }

  test("incomplete archive returns identity history and drops stats blobs", async () => {
    const { wrapCompactorWithCompletenessGate } =
      await import("./compaction-archive.js");
    const { archive } = memoryArchive();
    const inner = truncating("pruning-compactor");
    const wrapped = wrapCompactorWithCompletenessGate(inner, archive);
    const turns: import("@intx/types/runtime").ConversationTurn[] = [
      {
        role: "user",
        content: [{ type: "text", text: "secret-fact" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call-drop",
            name: "read_file",
            arguments: { path: "a.ts" },
          },
        ],
        timestamp: 2,
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            callId: "call-drop",
            content: [{ type: "text", text: "ok" }],
          },
        ],
        timestamp: 3,
      },
    ];

    const result = await wrapped.apply(turns, ctx);
    expect(result.output).toBe(turns);
    expect(result.blobs).toBeUndefined();
    expect(result.record.reason).toBe("incomplete-evidence-archive");
  });

  test("complete archive covering dropped callIds allows the rewrite", async () => {
    const { wrapCompactorWithCompletenessGate } =
      await import("./compaction-archive.js");
    const { archive } = memoryArchive();
    await archive.recordAuthorizedPayload({
      kind: "tool_args",
      payload: { name: "read_file", arguments: { path: "a.ts" } },
      callId: "call-drop",
    });
    await archive.recordAuthorizedPayload({
      kind: "tool_result",
      payload: "ok",
      callId: "call-drop",
    });
    await archive.recordAuthorizedPayload({
      kind: "user_message",
      payload: "secret-fact",
    });

    const inner = truncating("pruning-compactor");
    const wrapped = wrapCompactorWithCompletenessGate(inner, archive);
    const turns: import("@intx/types/runtime").ConversationTurn[] = [
      {
        role: "user",
        content: [{ type: "text", text: "secret-fact" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call-drop",
            name: "read_file",
            arguments: { path: "a.ts" },
          },
        ],
        timestamp: 2,
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            callId: "call-drop",
            content: [{ type: "text", text: "ok" }],
          },
        ],
        timestamp: 3,
      },
    ];

    const result = await wrapped.apply(turns, ctx);
    expect(result.output).toHaveLength(1);
    expect(result.blobs?.some((b) => b.key === "stats")).toBe(true);
    expect(result.record.reason).toBe("compact");
  });

  test("explicit gap records are not required for completeness", async () => {
    const { wrapCompactorWithCompletenessGate } =
      await import("./compaction-archive.js");
    const { archive } = memoryArchive();
    await archive.importHistoricalEvidence([
      { kind: "user_message", available: false, callId: "historical-gap" },
    ]);
    await archive.recordAuthorizedPayload({
      kind: "tool_result",
      payload: "ok",
      callId: "call-drop",
    });
    await archive.recordAuthorizedPayload({
      kind: "user_message",
      payload: "secret-fact",
    });

    const wrapped = wrapCompactorWithCompletenessGate(
      truncating("pruning-compactor"),
      archive,
    );
    const turns: import("@intx/types/runtime").ConversationTurn[] = [
      {
        role: "user",
        content: [{ type: "text", text: "secret-fact" }],
        timestamp: 1,
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            callId: "call-drop",
            content: [{ type: "text", text: "ok" }],
          },
        ],
        timestamp: 2,
      },
    ];
    const result = await wrapped.apply(turns, ctx);
    expect(result.output).toHaveLength(1);
    expect(result.record.reason).toBe("compact");
  });

  test("image-only dropped turns require covering attachment evidence", async () => {
    const { wrapCompactorWithCompletenessGate } =
      await import("./compaction-archive.js");
    const { archive } = memoryArchive();
    const wrapped = wrapCompactorWithCompletenessGate(
      truncating("pruning-compactor"),
      archive,
    );
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const png = base64Encode(pngBytes);
    const turns: import("@intx/types/runtime").ConversationTurn[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { kind: "base64", mimeType: "image/png", data: png },
          },
        ],
        timestamp: 1,
      },
      {
        role: "user",
        content: [{ type: "text", text: "keep" }],
        timestamp: 2,
      },
    ];

    const blocked = await wrapped.apply(turns, ctx);
    expect(blocked.output).toBe(turns);
    expect(blocked.record.reason).toBe("incomplete-evidence-archive");

    const agent = {
      deliver(_message: InboundMessage) {
        /* admission archives; history is the turns above */
      },
      async send(content: string | InboundMessage) {
        return { ok: true as const, content };
      },
    };
    const admitted = createPrimaryDeliveryAdmission(agent, archive);
    await admitted.send(
      inbound({
        attachments: [
          { name: "shot.png", contentType: "image/png", data: pngBytes },
        ],
      }),
    );
    const allowed = await wrapped.apply(turns, ctx);
    expect(allowed.output).toHaveLength(1);
    expect(allowed.record.reason).toBe("compact");
  });

  test("dropped list_dir and write_file results fail-close until archived", async () => {
    const { wrapCompactorWithCompletenessGate } =
      await import("./compaction-archive.js");
    const { archive } = memoryArchive();
    const wrapped = wrapCompactorWithCompletenessGate(
      truncating("pruning-compactor"),
      archive,
    );
    const turns: import("@intx/types/runtime").ConversationTurn[] = [
      {
        role: "user",
        content: [{ type: "text", text: "do work" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "ld",
            name: "list_dir",
            arguments: { path: "." },
          },
        ],
        timestamp: 2,
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            callId: "ld",
            content: [{ type: "text", text: "src/\n" }],
          },
        ],
        timestamp: 3,
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "wf",
            name: "write_file",
            arguments: { path: "a.ts" },
          },
        ],
        timestamp: 4,
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            callId: "wf",
            content: [{ type: "text", text: "wrote" }],
          },
        ],
        timestamp: 5,
      },
      {
        role: "user",
        content: [{ type: "text", text: "keep" }],
        timestamp: 6,
      },
    ];

    const blocked = await wrapped.apply(turns, ctx);
    expect(blocked.output).toBe(turns);
    expect(blocked.record.reason).toBe("incomplete-evidence-archive");

    await archive.recordAuthorizedPayload({
      kind: "user_message",
      payload: "do work",
    });
    await archive.recordAuthorizedPayload({
      kind: "tool_args",
      payload: { name: "list_dir", arguments: { path: "." } },
      callId: "ld",
    });
    await archive.recordAuthorizedPayload({
      kind: "tool_result",
      payload: "src/\n",
      callId: "ld",
    });
    await archive.recordAuthorizedPayload({
      kind: "tool_args",
      payload: { name: "write_file", arguments: { path: "a.ts" } },
      callId: "wf",
    });
    await archive.recordAuthorizedPayload({
      kind: "tool_result",
      payload: "wrote",
      callId: "wf",
    });

    const allowed = await wrapped.apply(turns, ctx);
    expect(allowed.output).toHaveLength(1);
    expect(allowed.record.reason).toBe("compact");
  });

  test("cloned keep-window turns are not treated as dropped", async () => {
    const { wrapCompactorWithCompletenessGate } =
      await import("./compaction-archive.js");
    const { archive } = memoryArchive();
    await archive.recordAuthorizedPayload({
      kind: "user_message",
      payload: "dropped-prefix",
    });
    const inner: import("@intx/types/runtime").Compactor = {
      name: "pruning-compactor",
      version: "1",
      async apply(turns) {
        const kept = turns
          .slice(-1)
          .map((turn) => ({ ...turn, content: [...turn.content] }));
        return {
          output: kept,
          record: {
            strategy: "pruning-compactor",
            version: "1",
            parameters: {},
            reason: "compact",
            decisions: { dropped: turns.length - 1 },
          },
        };
      },
    };
    const wrapped = wrapCompactorWithCompletenessGate(inner, archive);
    const turns: import("@intx/types/runtime").ConversationTurn[] = [
      {
        role: "user",
        content: [{ type: "text", text: "dropped-prefix" }],
        timestamp: 1,
      },
      {
        role: "user",
        content: [{ type: "text", text: "keep-window" }],
        timestamp: 2,
      },
    ];
    const result = await wrapped.apply(turns, ctx);
    expect(result.record.reason).toBe("compact");
    expect(result.output).toHaveLength(1);
    expect(result.output[0]).not.toBe(turns[1]);
  });
});
