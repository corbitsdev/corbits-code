// Authorized evidence archive for primary-session compaction.
//
// Captures the exact post-policy representation that enters (or is about to
// enter) durable history — never raw secrets, never a divergent scrubbed copy
// while history stays raw. Storage is owned by the session context directory
// via ContextStore blobs plus an append-only occurrence index. Completeness is
// an explicit certificate over an expected occurrence range and verified blobs;
// readAt salvage is not a certificate.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type } from "arktype";
import type {
  Compactor,
  ConversationTurn,
  InboundMessage,
  StrategyContext,
} from "@intx/types/runtime";
import { scrubSecretShapedContent } from "../plugins/tool-result-secret-scrub.js";
import {
  ArchiveOccurrence,
  CompletenessCertificate,
  HistoricalImportResult,
  type ArchiveKind,
  type ToolRecordingLifecycle,
} from "./compaction-archive-schema.js";

const INDEX_DIR = "evidence-archive";
const INDEX_FILE = "index.jsonl";

export type ArchiveBlobWriter = (
  key: string,
  bytes: Uint8Array,
  contentType?: string,
) => Promise<void>;

export type ArchiveBlobReader = (key: string) => Promise<Uint8Array>;

export interface CreateCompactionArchiveOpts {
  sessionId: string;
  contextDir: string;
  writeBlob: ArchiveBlobWriter;
  readBlob: ArchiveBlobReader;
  now?: () => number;
}

export interface RecordAuthorizedPayloadInput {
  kind: ArchiveKind;
  payload: string | Record<string, unknown> | unknown;
  callId?: string;
  lifecycle?: ToolRecordingLifecycle;
  provenance?: string;
  gap?: boolean;
}

export interface RecordExistingBlobInput {
  kind: Extract<ArchiveKind, "overflow_blob" | "attachment">;
  blobKey: string;
  contentHash: string;
  callId?: string;
  provenance?: string;
}

export interface ToolCallRecordingInput {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface FinalizeToolRecordingInput {
  callId: string;
  name: string;
  lifecycle: ToolRecordingLifecycle;
  executionArgs: Record<string, unknown>;
}

export interface HistoricalEvidenceItem {
  kind: ArchiveKind;
  payload?: string | Record<string, unknown>;
  available: boolean;
  callId?: string;
}

export interface CompactionArchive {
  recordAuthorizedPayload(input: RecordAuthorizedPayloadInput): Promise<ArchiveOccurrence>;
  recordExistingBlobReference(input: RecordExistingBlobInput): Promise<ArchiveOccurrence>;
  noteToolRequested(call: ToolCallRecordingInput): Promise<void>;
  finalizeToolRecording(input: FinalizeToolRecordingInput): Promise<ArchiveOccurrence>;
  readAuthorizedPayload(occurrenceId: string): Promise<string>;
  listOccurrences(): Promise<ArchiveOccurrence[]>;
  certifyRange(expectedOccurrenceIds: readonly string[]): Promise<CompletenessCertificate>;
  importHistoricalEvidence(
    items: readonly HistoricalEvidenceItem[],
  ): Promise<HistoricalImportResult>;
  /** Drain recording writes started from sync deliver paths before certifying. */
  awaitPendingWrites(): Promise<void>;
}

function indexPath(contextDir: string): string {
  return path.join(contextDir, INDEX_DIR, INDEX_FILE);
}

export function hashAuthorizedBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function applyRecordingPolicyToText(text: string): string {
  return scrubSecretShapedContent(text);
}

export function applyRecordingPolicyToValue(value: unknown): unknown {
  if (typeof value === "string") return applyRecordingPolicyToText(value);
  if (Array.isArray(value)) return value.map((item) => applyRecordingPolicyToValue(item));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && isCredentialKeyedField(key)) {
        out[key] = CREDENTIAL_VALUE_REDACTION(child);
      } else {
        out[key] = applyRecordingPolicyToValue(child);
      }
    }
    return out;
  }
  return value;
}

function isCredentialKeyedField(key: string): boolean {
  return /^(?:api[_-]?key|access[_-]?token|token|password|secret|credential|authorization)$/i.test(
    key,
  );
}

function CREDENTIAL_VALUE_REDACTION(value: string): string {
  const scrubbed = applyRecordingPolicyToText(value);
  // Keyed credential fields always redact even when the value shape is unfamiliar.
  return scrubbed === value ? "[redacted: looks like a credential]" : scrubbed;
}

export function authorizedToolArgsRepresentation(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const clone = structuredClone(args);
  return applyRecordingPolicyToValue(clone) as Record<string, unknown>;
}

export function isControlOrEmptyInbound(message: InboundMessage): boolean {
  const content = message.content ?? "";
  const attachments = message.attachments ?? [];
  if (content.length === 0 && attachments.length === 0) return true;
  if (message.ref.mailbox === "approval" || message.ref.mailbox === "system") return true;
  if (message.headers.interchangeCorrelationId !== undefined) {
    // Correlated approval/control deliveries carry decision JSON; do not scrub.
    if (message.headers.interchangeType !== "conversation.message") return true;
    if (message.ref.mailbox === "approval") return true;
  }
  return false;
}

/**
 * Primary admission hook (Corbits-owned). Produces the canonical admitted
 * representation that must enter history and the archive — same bytes, not a
 * divergent scrubbed copy. Workers omit this hook.
 */
export function admitPrimaryInboundMessage(message: InboundMessage): InboundMessage {
  if (isControlOrEmptyInbound(message)) return message;
  const content = message.content ?? "";
  if (content.length === 0) return message;
  const admittedContent = applyRecordingPolicyToText(content);
  if (admittedContent === content) return message;
  return { ...message, content: admittedContent };
}

async function archiveAdmittedInbound(
  archive: CompactionArchive,
  admitted: InboundMessage,
): Promise<void> {
  if (isControlOrEmptyInbound(admitted)) return;
  const content = admitted.content ?? "";
  if (content.length > 0) {
    await archive.recordAuthorizedPayload({
      kind: "user_message",
      payload: content,
      provenance: "primary-admission",
    });
  }
  for (const attachment of admitted.attachments ?? []) {
    if (attachment.data === undefined) {
      await archive.recordAuthorizedPayload({
        kind: "attachment",
        payload: {
          name: attachment.name,
          contentType: attachment.contentType,
          status: "missing",
        },
        provenance: "primary-admission:attachment-missing",
        gap: true,
      });
      continue;
    }
    const bytes =
      attachment.data instanceof Uint8Array
        ? attachment.data
        : new TextEncoder().encode(String(attachment.data));
    const contentHash = hashAuthorizedBytes(bytes);
    // Binary attachments are not scrubbed; record hash + provenance only.
    await archive.recordAuthorizedPayload({
      kind: "attachment",
      payload: {
        name: attachment.name,
        contentType: attachment.contentType,
        contentHash,
        byteLength: bytes.byteLength,
      },
      provenance: "primary-admission:attachment-meta",
    });
  }
}

export function createPrimaryDeliveryAdmission<
  T extends {
    deliver: (message: InboundMessage) => void;
    send: (content: string | InboundMessage, ...rest: never[]) => unknown;
  },
>(agent: T, archive?: CompactionArchive): T {
  return {
    ...agent,
    deliver(message: InboundMessage) {
      const admitted = admitPrimaryInboundMessage(message);
      agent.deliver(admitted);
      if (archive !== undefined) {
        // deliver() is sync; track the write so certify/awaitPendingWrites can wait.
        trackPendingWrite(archive, archiveAdmittedInbound(archive, admitted));
      }
    },
    send(content: string | InboundMessage, ...rest: never[]) {
      if (typeof content === "string") {
        const admitted = content.length === 0 ? content : applyRecordingPolicyToText(content);
        if (archive === undefined || admitted.length === 0) {
          return agent.send(admitted, ...rest);
        }
        const run = async () => {
          await archive.recordAuthorizedPayload({
            kind: "user_message",
            payload: admitted,
            provenance: "primary-admission",
          });
          return agent.send(admitted, ...rest);
        };
        return run();
      }
      const admitted = admitPrimaryInboundMessage(content);
      if (archive === undefined) {
        return agent.send(admitted, ...rest);
      }
      const run = async () => {
        await archiveAdmittedInbound(archive, admitted);
        return agent.send(admitted, ...rest);
      };
      return run();
    },
  };
}

const pendingWrites = new WeakMap<object, Set<Promise<unknown>>>();

function trackPendingWrite(archive: object, write: Promise<unknown>): void {
  let set = pendingWrites.get(archive);
  if (set === undefined) {
    set = new Set();
    pendingWrites.set(archive, set);
  }
  const tracked = write.then(
    () => undefined,
    () => undefined,
  );
  set.add(tracked);
  void tracked.finally(() => set.delete(tracked));
}

export async function awaitArchivePendingWrites(archive: object): Promise<void> {
  const set = pendingWrites.get(archive);
  if (set === undefined || set.size === 0) return;
  await Promise.all([...set]);
}

export function wrapAuthorizeWithEvidenceArchive<
  TResult extends { effect: string | null },
  TAuthorize extends (resource: string, action: string, context: unknown) => Promise<TResult>,
>(authorize: TAuthorize, getArchive: () => CompactionArchive | undefined): TAuthorize {
  const wrapped = (async (resource: string, action: string, context: unknown) => {
    const archive = getArchive();
    const call =
      context !== null &&
      typeof context === "object" &&
      "id" in context &&
      "name" in context &&
      "arguments" in context
        ? (context as { id: string; name: string; arguments: Record<string, unknown> })
        : undefined;

    if (archive !== undefined && call !== undefined && action === "invoke") {
      await archive.noteToolRequested({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      });
    }

    const result = await authorize(resource, action, context);

    if (
      archive !== undefined &&
      call !== undefined &&
      action === "invoke" &&
      (result.effect === "allow" || result.effect === "deny" || result.effect === "ask")
    ) {
      const lifecycle =
        result.effect === "allow" ? "admitted" : result.effect === "deny" ? "denied" : "suspended";
      await archive.finalizeToolRecording({
        callId: call.id,
        name: call.name,
        lifecycle,
        executionArgs: call.arguments,
      });
    }

    return result;
  }) as TAuthorize;
  return wrapped;
}

function encodePayload(payload: unknown): { bytes: Uint8Array; contentType: string } {
  if (typeof payload === "string") {
    return { bytes: new TextEncoder().encode(payload), contentType: "text/plain" };
  }
  return {
    bytes: new TextEncoder().encode(JSON.stringify(payload)),
    contentType: "application/json",
  };
}

function occurrenceBlobKey(sessionId: string, occurrenceId: string): string {
  // ContextStore.writeBlob rejects slash-containing keys (sanitizeCallId).
  return `archive-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${occurrenceId}`;
}

async function appendIndex(contextDir: string, occurrence: ArchiveOccurrence): Promise<void> {
  const file = indexPath(contextDir);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.appendFile(file, `${JSON.stringify(occurrence)}\n`, "utf8");
}

async function readIndex(contextDir: string): Promise<ArchiveOccurrence[]> {
  const file = indexPath(contextDir);
  try {
    const text = await fs.promises.readFile(file, "utf8");
    if (text.length === 0) return [];
    const out: ArchiveOccurrence[] = [];
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      const parsed = ArchiveOccurrence(JSON.parse(line));
      if (parsed instanceof type.errors) {
        throw new Error(`evidence archive index corrupt: ${parsed.summary}`);
      }
      out.push(parsed);
    }
    return out;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
}

function mintOccurrenceId(parts: {
  sessionId: string;
  kind: string;
  contentHash: string;
  callId?: string;
  lifecycle?: string;
  recordedAt: number;
}): string {
  const material = [
    parts.sessionId,
    parts.kind,
    parts.contentHash,
    parts.callId ?? "",
    parts.lifecycle ?? "",
    String(parts.recordedAt),
  ].join("|");
  return `occ-${createHash("sha256").update(material).digest("hex").slice(0, 24)}`;
}

export function createCompactionArchive(opts: CreateCompactionArchiveOpts): CompactionArchive {
  const { sessionId, contextDir, writeBlob, readBlob } = opts;
  const now = opts.now ?? (() => Date.now());
  const requested = new Map<string, ToolCallRecordingInput>();
  async function persistOccurrence(
    input: RecordAuthorizedPayloadInput & { blobKey?: string; skipWrite?: boolean },
  ): Promise<ArchiveOccurrence> {
    const recordedAt = now();
    const { bytes, contentType } = encodePayload(input.payload ?? "");
    const contentHash = hashAuthorizedBytes(bytes);
    const occurrenceId = mintOccurrenceId({
      sessionId,
      kind: input.kind,
      contentHash,
      ...(input.callId !== undefined ? { callId: input.callId } : {}),
      ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle } : {}),
      recordedAt,
    });
    const blobKey = input.blobKey ?? occurrenceBlobKey(sessionId, occurrenceId);
    if (input.skipWrite !== true && input.gap !== true) {
      await writeBlob(blobKey, bytes, contentType);
    }
    const occurrence = ArchiveOccurrence({
      occurrenceId,
      sessionId,
      kind: input.kind,
      contentHash,
      blobKey,
      recordedAt,
      ...(input.callId !== undefined ? { callId: input.callId } : {}),
      ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle } : {}),
      ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
      ...(input.gap === true ? { gap: true } : {}),
    });
    if (occurrence instanceof type.errors) {
      throw new Error(`invalid archive occurrence: ${occurrence.summary}`);
    }
    await appendIndex(contextDir, occurrence);
    return occurrence;
  }

  const archive: CompactionArchive = {
    async recordAuthorizedPayload(input) {
      return persistOccurrence(input);
    },

    async recordExistingBlobReference(input) {
      let gap = false;
      try {
        const bytes = await readBlob(input.blobKey);
        const actual = hashAuthorizedBytes(bytes);
        if (actual !== input.contentHash) gap = true;
      } catch {
        gap = true;
      }
      const recordedAt = now();
      const occurrenceId = mintOccurrenceId({
        sessionId,
        kind: input.kind,
        contentHash: input.contentHash,
        ...(input.callId !== undefined ? { callId: input.callId } : {}),
        recordedAt,
      });
      const occurrence = ArchiveOccurrence({
        occurrenceId,
        sessionId,
        kind: input.kind,
        contentHash: input.contentHash,
        blobKey: input.blobKey,
        recordedAt,
        ...(input.callId !== undefined ? { callId: input.callId } : {}),
        ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
        ...(gap ? { gap: true } : {}),
      });
      if (occurrence instanceof type.errors) {
        throw new Error(`invalid archive occurrence: ${occurrence.summary}`);
      }
      await appendIndex(contextDir, occurrence);
      return occurrence;
    },

    async noteToolRequested(call) {
      // Observation only — execution args are not scrubbed in place.
      requested.set(call.id, call);
    },

    async finalizeToolRecording(input) {
      const recordedArgs = authorizedToolArgsRepresentation(input.executionArgs);
      if (input.lifecycle === "denied") {
        return persistOccurrence({
          kind: "tool_failure",
          lifecycle: "denied",
          callId: input.callId,
          payload: {
            name: input.name,
            lifecycle: "denied",
            arguments: recordedArgs,
          },
          provenance: "authz:denied",
        });
      }
      if (input.lifecycle === "suspended") {
        return persistOccurrence({
          kind: "tool_args",
          lifecycle: "suspended",
          callId: input.callId,
          payload: {
            name: input.name,
            lifecycle: "suspended",
            arguments: recordedArgs,
          },
          provenance: "authz:suspended",
        });
      }
      requested.delete(input.callId);
      return persistOccurrence({
        kind: "tool_args",
        lifecycle: "admitted",
        callId: input.callId,
        payload: {
          name: input.name,
          lifecycle: "admitted",
          arguments: recordedArgs,
        },
        provenance: "authz:admitted",
      });
    },

    async readAuthorizedPayload(occurrenceId) {
      const occurrences = await readIndex(contextDir);
      const hit = occurrences.find((o) => o.occurrenceId === occurrenceId);
      if (hit === undefined) throw new Error(`unknown occurrence ${occurrenceId}`);
      if (hit.gap === true) throw new Error(`occurrence ${occurrenceId} is an explicit gap`);
      const bytes = await readBlob(hit.blobKey);
      return new TextDecoder().decode(bytes);
    },

    async listOccurrences() {
      return readIndex(contextDir);
    },

    async awaitPendingWrites() {
      await awaitArchivePendingWrites(archive);
    },

    async certifyRange(expectedOccurrenceIds) {
      await awaitArchivePendingWrites(archive);
      const expected = [...expectedOccurrenceIds];
      const occurrences = await readIndex(contextDir);
      const byId = new Map(occurrences.map((o) => [o.occurrenceId, o]));
      const presentOccurrenceIds: string[] = [];
      const missingOccurrenceIds: string[] = [];
      const unverifiedBlobIds: string[] = [];

      for (const id of expected) {
        const occ = byId.get(id);
        if (occ === undefined) {
          missingOccurrenceIds.push(id);
          continue;
        }
        presentOccurrenceIds.push(id);
        if (occ.gap === true) {
          unverifiedBlobIds.push(id);
          continue;
        }
        try {
          const bytes = await readBlob(occ.blobKey);
          if (hashAuthorizedBytes(bytes) !== occ.contentHash) {
            unverifiedBlobIds.push(id);
          }
        } catch {
          unverifiedBlobIds.push(id);
        }
      }

      const status =
        missingOccurrenceIds.length === 0 && unverifiedBlobIds.length === 0
          ? "complete"
          : "incomplete";
      const certificate = CompletenessCertificate({
        status,
        expectedOccurrenceIds: expected,
        presentOccurrenceIds,
        missingOccurrenceIds,
        unverifiedBlobIds,
        certifiedAt: now(),
      });
      if (certificate instanceof type.errors) {
        throw new Error(`invalid completeness certificate: ${certificate.summary}`);
      }
      return certificate;
    },

    async importHistoricalEvidence(items) {
      const importedOccurrenceIds: string[] = [];
      const gapOccurrenceIds: string[] = [];
      for (const item of items) {
        if (item.available) {
          const occ = await persistOccurrence({
            kind: item.kind,
            payload: item.payload ?? "",
            ...(item.callId !== undefined ? { callId: item.callId } : {}),
            provenance: "historical-import",
          });
          importedOccurrenceIds.push(occ.occurrenceId);
        } else {
          const occ = await persistOccurrence({
            kind: item.kind,
            payload: "",
            ...(item.callId !== undefined ? { callId: item.callId } : {}),
            provenance: "historical-import:gap",
            gap: true,
            skipWrite: true,
          });
          gapOccurrenceIds.push(occ.occurrenceId);
        }
      }
      const result = HistoricalImportResult({ importedOccurrenceIds, gapOccurrenceIds });
      if (result instanceof type.errors) {
        throw new Error(`invalid historical import result: ${result.summary}`);
      }
      return result;
    },
  };
  return archive;
}

function textKindForRole(role: ConversationTurn["role"]): ArchiveKind {
  if (role === "assistant") return "assistant_text";
  return "user_message";
}

function coveringOccurrence(
  units: readonly {
    kind: "text" | "tool_call" | "tool_result";
    text?: string;
    role?: ConversationTurn["role"];
    callId?: string;
  }[],
  occurrences: readonly ArchiveOccurrence[],
): { ids: string[]; unmatched: boolean } {
  const used = new Set<string>();
  const ids: string[] = [];
  for (const unit of units) {
    const match = occurrences.find((occ) => {
      if (used.has(occ.occurrenceId) || occ.gap === true) return false;
      if (unit.kind === "text") {
        if (unit.role === undefined || unit.text === undefined) return false;
        if (occ.kind !== textKindForRole(unit.role)) return false;
        return occ.contentHash === hashAuthorizedBytes(new TextEncoder().encode(unit.text));
      }
      if (unit.callId === undefined || occ.callId !== unit.callId) return false;
      if (unit.kind === "tool_call") return occ.kind === "tool_args" || occ.kind === "tool_failure";
      return occ.kind === "tool_result" || occ.kind === "overflow_blob";
    });
    if (match === undefined) return { ids, unmatched: true };
    used.add(match.occurrenceId);
    ids.push(match.occurrenceId);
  }
  return { ids, unmatched: false };
}

function droppedContentUnits(dropped: readonly ConversationTurn[]): {
  kind: "text" | "tool_call" | "tool_result";
  text?: string;
  role?: ConversationTurn["role"];
  callId?: string;
}[] {
  const units: {
    kind: "text" | "tool_call" | "tool_result";
    text?: string;
    role?: ConversationTurn["role"];
    callId?: string;
  }[] = [];
  for (const turn of dropped) {
    for (const block of turn.content) {
      if (block.type === "text" && block.text.length > 0) {
        units.push({ kind: "text", role: turn.role, text: block.text });
      } else if (block.type === "tool_call") {
        units.push({ kind: "tool_call", callId: block.id });
      } else if (block.type === "tool_result") {
        units.push({ kind: "tool_result", callId: block.callId });
      }
    }
  }
  return units;
}

function incompleteIdentity(inner: Compactor, turns: ConversationTurn[]) {
  return {
    output: turns,
    record: {
      strategy: inner.name,
      version: inner.version,
      parameters: {},
      reason: "incomplete-evidence-archive",
      decisions: {},
    },
  };
}

/**
 * Refuse a destructive compact when the evidence archive cannot certify the
 * dropped prefix. Historical gap:true rows are not part of the expected set.
 */
export function wrapCompactorWithCompletenessGate(
  inner: Compactor,
  archive: CompactionArchive,
): Compactor {
  return {
    name: inner.name,
    version: inner.version,
    async apply(turns: ConversationTurn[], ctx: StrategyContext) {
      await archive.awaitPendingWrites();
      const proposed = await inner.apply(turns, ctx);
      const dropped = turns.filter((turn) => !proposed.output.includes(turn));
      const units = droppedContentUnits(dropped);
      if (units.length === 0) return proposed;
      const occurrences = await archive.listOccurrences();
      const covering = coveringOccurrence(units, occurrences);
      if (covering.unmatched || covering.ids.length === 0) {
        return incompleteIdentity(inner, turns);
      }
      const certificate = await archive.certifyRange(covering.ids);
      if (certificate.status !== "complete") {
        return incompleteIdentity(inner, turns);
      }
      return proposed;
    },
  };
}
