import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InboundMessage } from "@intx/types/runtime";
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

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "compaction-archive-"));
}

function inbound(partial: Partial<InboundMessage> & { content?: string }): InboundMessage {
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
    ...(partial.attachments !== undefined ? { attachments: partial.attachments } : {}),
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
      command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345' https://x",
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
    expect(admitted.content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
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
    const bytes = new TextEncoder().encode("sk-abcdefghijklmnopqrstuvwxyz012345");
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
      async send(message: InboundMessage) {
        delivered.push(message);
        return { ok: true as const };
      },
    };
    const wrapped = createPrimaryDeliveryAdmission(agent);
    wrapped.deliver(inbound({ content: "leak sk-abcdefghijklmnopqrstuvwxyz012345" }));
    await wrapped.send(inbound({ content: "also sk-abcdefghijklmnopqrstuvwxyz012345" }));
    expect(delivered).toHaveLength(2);
    expect(delivered[0]!.content).toContain(CREDENTIAL_REDACTION);
    expect(delivered[1]!.content).toContain(CREDENTIAL_REDACTION);
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
    const payload = JSON.parse(await archive.readAuthorizedPayload(denied.occurrenceId));
    expect(payload.lifecycle).toBe("denied");
    expect(payload.arguments.token).toBe(CREDENTIAL_REDACTION);
    expect(JSON.stringify(payload)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
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
    await archive.noteToolRequested({ id: "ask-1", name: "read_file", arguments: args });
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

    const cert = await archive.certifyRange([overflow.occurrenceId, missing.occurrenceId]);
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
      { kind: "tool_result", payload: "lost", available: false, callId: "old-1" },
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
});
