import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import type { AgentTool } from "@intx/agent";
import { CATALOG_TOOL_NAMES, CORE_TOOL_NAMES } from "./tool-search.js";
import {
  createReadArchiveTool,
  createSearchArchiveTool,
  readArchiveDefinition,
  searchArchiveDefinition,
} from "./archive-tools.js";
import { formatArchiveRef } from "../session/archive-uri.js";
import { createCompactionArchive, type CompactionArchive } from "../session/compaction-archive.js";

function call(tool: AgentTool, args: Record<string, unknown>): Promise<string> {
  if (tool.kind !== "string") throw new Error("expected string tool");
  return tool.handler(args, new AbortController().signal);
}

function memoryArchive(sessionId: string): CompactionArchive {
  const dir = mkdtempSync(join(tmpdir(), "archive-tools-"));
  const blobs = new Map<string, Uint8Array>();
  return createCompactionArchive({
    sessionId,
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
}

function wrapReads(archive: CompactionArchive): string[] {
  const ids: string[] = [];
  const orig = archive.readAuthorizedPayload.bind(archive);
  archive.readAuthorizedPayload = async (occurrenceId) => {
    ids.push(occurrenceId);
    return orig(occurrenceId);
  };
  return ids;
}

describe("archive tool definitions", () => {
  test("catalog advertises search_archive and read_archive; they are not CORE", () => {
    expect(CORE_TOOL_NAMES).not.toContain("search_archive");
    expect(CORE_TOOL_NAMES).not.toContain("read_archive");
    expect(CATALOG_TOOL_NAMES).toContain("search_archive");
    expect(CATALOG_TOOL_NAMES).toContain("read_archive");
    expect(searchArchiveDefinition.description).toContain("archive:///");
    expect(readArchiveDefinition.description).toContain("archive:///");
  });
});

describe("search_archive and read_archive", () => {
  test("search returns archive:/// refs and read returns the payload", async () => {
    const archive = memoryArchive("sess-primary");
    const occ = await archive.recordAuthorizedPayload({
      kind: "user_message",
      payload: "unique-payload-alpha",
      provenance: "primary-admission",
    });
    const search = createSearchArchiveTool(() => archive);
    const read = createReadArchiveTool(() => archive);

    const hits = await call(search, { query: "unique-payload-alpha" });
    expect(hits).toContain(formatArchiveRef(occ.occurrenceId));
    expect(hits).toContain("user_message");
    expect(hits).not.toContain(occ.sessionId);
    expect(hits).not.toContain(occ.blobKey);

    const body = await call(read, { ref: formatArchiveRef(occ.occurrenceId) });
    expect(body).toContain("unique-payload-alpha");
    expect(body).not.toContain(occ.blobKey);
  });

  test("gap rows match metadata only and never load payload", async () => {
    const archive = memoryArchive("sess-gap");
    const reads = wrapReads(archive);
    const gap = await archive.recordAuthorizedPayload({
      kind: "attachment",
      payload: { secret: "gap-payload-must-not-search" },
      provenance: "primary-admission:attachment-missing",
      gap: true,
    });
    const search = createSearchArchiveTool(() => archive);
    const read = createReadArchiveTool(() => archive);

    const payloadHits = await call(search, { query: "gap-payload-must-not-search" });
    expect(payloadHits).toContain("No evidence-archive occurrences matched");
    expect(reads).toEqual([]);

    const metaHits = await call(search, { query: "attachment-missing" });
    expect(metaHits).toContain(formatArchiveRef(gap.occurrenceId));
    expect(metaHits).toContain("gap");
    expect(reads).toEqual([]);

    const body = await call(read, { ref: formatArchiveRef(gap.occurrenceId) });
    expect(body).toContain("explicit gap");
    expect(reads).toEqual([gap.occurrenceId]);
  });

  test("forged and other-session refs are not found", async () => {
    const primary = memoryArchive("sess-a");
    const other = memoryArchive("sess-b");
    const foreign = await other.recordAuthorizedPayload({
      kind: "assistant_text",
      payload: "other-session-only",
    });
    const read = createReadArchiveTool(() => primary);
    const search = createSearchArchiveTool(() => primary);

    const forged = await call(read, { ref: "archive:///occ-forged-not-in-index" });
    expect(forged).toContain("unknown occurrence");

    const cross = await call(read, { ref: formatArchiveRef(foreign.occurrenceId) });
    expect(cross).toContain("unknown occurrence");

    const hits = await call(search, { query: "other-session-only" });
    expect(hits).toContain("No evidence-archive occurrences matched");
  });

  test("rejects sessionId, path, and blobKey locators", async () => {
    const archive = memoryArchive("sess-locators");
    const occ = await archive.recordAuthorizedPayload({
      kind: "user_message",
      payload: "locator-payload",
    });
    const search = createSearchArchiveTool(() => archive);
    const read = createReadArchiveTool(() => archive);
    const ref = formatArchiveRef(occ.occurrenceId);

    for (const args of [
      { query: "locator-payload", sessionId: "sess-locators" },
      { query: "locator-payload", path: "evidence-archive/index.jsonl" },
      { query: "locator-payload", blobKey: occ.blobKey },
    ]) {
      const out = await call(search, args);
      expect(out).toContain("does not accept sessionId, path, or blobKey");
    }

    for (const args of [
      { ref, sessionId: "sess-locators" },
      { ref, path: "evidence-archive/index.jsonl" },
      { ref, blobKey: occ.blobKey },
    ]) {
      const out = await call(read, args);
      expect(out).toContain("does not accept sessionId, path, or blobKey");
    }

    const badRef = await call(read, { ref: occ.occurrenceId });
    expect(badRef).toContain("archive:///{occurrenceId}");
  });

  test("read_archive pages with offset and limit via readBytesBounded", async () => {
    const archive = memoryArchive("sess-page");
    const lines = Array.from({ length: 8 }, (_, i) => `archive-line-${i}`).join("\n");
    const occ = await archive.recordAuthorizedPayload({
      kind: "tool_result",
      payload: lines,
    });
    const read = createReadArchiveTool(() => archive);
    const body = await call(read, {
      ref: formatArchiveRef(occ.occurrenceId),
      offset: 2,
      limit: 2,
    });
    expect(body).toContain("archive-line-2");
    expect(body).toContain("archive-line-3");
    expect(body).not.toContain("archive-line-0");
    expect(body).not.toContain("archive-line-4");
    expect(body).toContain("Use offset=");
  });
});

describe("createAgentToolset archive mount", () => {
  test("mounts search_archive and read_archive only when getEvidenceArchive is set", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "corbits-archive-mount-"));
    const { createAgentToolset } = await import("./tools.js");
    const permissionGate = {
      check: async () => ({ allowed: true }),
      getSkipPermissions: () => false,
    } as never;

    const worker = await createAgentToolset({
      cwd,
      permissionGate,
      onOperatorGate: async () => ({ kind: "option", index: 0 }),
    });
    const workerNames = worker.dynamicRunner.currentDefinitions().map((d) => d.name);
    expect(workerNames).not.toContain("search_archive");
    expect(workerNames).not.toContain("read_archive");
    await worker.dispose();

    const primary = await createAgentToolset({
      cwd,
      permissionGate,
      onOperatorGate: async () => ({ kind: "option", index: 0 }),
      getEvidenceArchive: () => undefined,
    });
    const primaryNames = primary.dynamicRunner.currentDefinitions().map((d) => d.name);
    expect(primaryNames).toContain("search_archive");
    expect(primaryNames).toContain("read_archive");
    await primary.dispose();
  });
});
