import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import type { ToolCall, ToolResult } from "@intx/types/runtime";
import {
  advertiseArchiveSurface,
  evidenceArchiveSearchPlugin,
} from "./evidence-archive-search-plugin.js";
import { formatArchiveRef } from "../session/archive-uri.js";
import { createCompactionArchive, type CompactionArchive } from "../session/compaction-archive.js";
import { CATALOG_TOOL_NAMES, CORE_TOOL_NAMES } from "../agent/tool-search.js";

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "test-call", name, arguments: args };
}

const nextHandler = async (call: ToolCall): Promise<ToolResult> => ({
  callId: call.id,
  content: `passthrough:${call.name}`,
});

function memoryArchive(sessionId: string): CompactionArchive {
  const dir = mkdtempSync(join(tmpdir(), "archive-search-"));
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

describe("advertiseArchiveSurface", () => {
  test("mentions archive:/// on search_files, read_file, and grep", () => {
    expect(CORE_TOOL_NAMES).not.toContain("search_archive");
    expect(CORE_TOOL_NAMES).not.toContain("read_archive");
    expect(CATALOG_TOOL_NAMES).not.toContain("search_archive");
    expect(CATALOG_TOOL_NAMES).not.toContain("read_archive");
    const read = advertiseArchiveSurface({
      name: "read_file",
      description: "Read a file.",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    });
    expect(read.description).toContain("archive:///");
    const grep = advertiseArchiveSurface({
      name: "grep",
      description: "Search file contents.",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    });
    expect(grep.description).toContain("archive:///");
    const search = advertiseArchiveSurface({
      name: "search_files",
      description: "Find files.",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    });
    expect(search.description).toContain("archive:///");
  });
});

describe("evidenceArchiveSearchPlugin", () => {
  test("search_files lists archive:/// refs and read_file returns the payload", async () => {
    const archive = memoryArchive("sess-primary");
    const occ = await archive.recordAuthorizedPayload({
      kind: "user_message",
      payload: "unique-payload-alpha",
      provenance: "primary-admission",
    });
    const plugin = evidenceArchiveSearchPlugin(() => archive);
    const handler = plugin.middleware ? plugin.middleware(nextHandler) : nextHandler;

    const hits = await handler(
      makeCall("search_files", { pattern: "*", path: "archive:///" }),
      new AbortController().signal,
    );
    expect(String(hits.content)).toContain(formatArchiveRef(occ.occurrenceId));
    expect(String(hits.content)).not.toContain(occ.sessionId);
    expect(String(hits.content)).not.toContain(occ.blobKey);

    const grepHits = await handler(
      makeCall("grep", { pattern: "unique-payload-alpha", path: "archive:///" }),
      new AbortController().signal,
    );
    expect(String(grepHits.content)).toContain(formatArchiveRef(occ.occurrenceId));
    expect(String(grepHits.content)).toContain("unique-payload-alpha");
    expect(String(grepHits.content)).not.toContain(occ.blobKey);

    const body = await handler(
      makeCall("read_file", { path: formatArchiveRef(occ.occurrenceId) }),
      new AbortController().signal,
    );
    expect(String(body.content)).toContain("unique-payload-alpha");
    expect(String(body.content)).not.toContain(occ.blobKey);
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
    const plugin = evidenceArchiveSearchPlugin(() => archive);
    const handler = plugin.middleware ? plugin.middleware(nextHandler) : nextHandler;

    const payloadHits = await handler(
      makeCall("grep", { pattern: "gap-payload-must-not-search", path: "archive:///" }),
      new AbortController().signal,
    );
    expect(String(payloadHits.content)).toContain("no matches");
    expect(reads).toEqual([]);

    const metaHits = await handler(
      makeCall("grep", { pattern: "attachment-missing", path: "archive:///" }),
      new AbortController().signal,
    );
    expect(String(metaHits.content)).toContain(formatArchiveRef(gap.occurrenceId));
    expect(String(metaHits.content)).toContain("gap");
    expect(reads).toEqual([]);

    const body = await handler(
      makeCall("read_file", { path: formatArchiveRef(gap.occurrenceId) }),
      new AbortController().signal,
    );
    expect(body.isError).toBe(true);
    expect(String(body.content)).toContain("explicit gap");
    expect(reads).toEqual([gap.occurrenceId]);
  });

  test("forged and other-session refs are not found", async () => {
    const primary = memoryArchive("sess-a");
    const other = memoryArchive("sess-b");
    const foreign = await other.recordAuthorizedPayload({
      kind: "assistant_text",
      payload: "other-session-only",
    });
    const plugin = evidenceArchiveSearchPlugin(() => primary);
    const handler = plugin.middleware ? plugin.middleware(nextHandler) : nextHandler;

    const forged = await handler(
      makeCall("read_file", { path: "archive:///occ-forged-not-in-index" }),
      new AbortController().signal,
    );
    expect(forged.isError).toBe(true);
    expect(String(forged.content)).toContain("unknown occurrence");

    const cross = await handler(
      makeCall("read_file", { path: formatArchiveRef(foreign.occurrenceId) }),
      new AbortController().signal,
    );
    expect(cross.isError).toBe(true);
    expect(String(cross.content)).toContain("unknown occurrence");

    const hits = await handler(
      makeCall("grep", { pattern: "other-session-only", path: "archive:///" }),
      new AbortController().signal,
    );
    expect(String(hits.content)).toContain("no matches");
  });

  test("read_file pages archive payloads with offset and limit", async () => {
    const archive = memoryArchive("sess-page");
    const lines = Array.from({ length: 8 }, (_, i) => `archive-line-${i}`).join("\n");
    const occ = await archive.recordAuthorizedPayload({
      kind: "tool_result",
      payload: lines,
    });
    const plugin = evidenceArchiveSearchPlugin(() => archive);
    const handler = plugin.middleware ? plugin.middleware(nextHandler) : nextHandler;
    const body = await handler(
      makeCall("read_file", {
        path: formatArchiveRef(occ.occurrenceId),
        offset: 2,
        limit: 2,
      }),
      new AbortController().signal,
    );
    expect(String(body.content)).toContain("archive-line-2");
    expect(String(body.content)).toContain("archive-line-3");
    expect(String(body.content)).not.toContain("archive-line-0");
    expect(String(body.content)).not.toContain("archive-line-4");
    expect(String(body.content)).toContain("Use offset=");
  });

  test("passes ordinary workspace paths through", async () => {
    const plugin = evidenceArchiveSearchPlugin(() => memoryArchive("sess-pass"));
    const handler = plugin.middleware ? plugin.middleware(nextHandler) : nextHandler;
    const result = await handler(
      makeCall("grep", { pattern: "foo", path: "src" }),
      new AbortController().signal,
    );
    expect(result.content).toBe("passthrough:grep");
  });
});

describe("createAgentToolset archive mount", () => {
  test("does not mount dedicated archive tools; primary advertises archive:/// on posix search", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "corbits-archive-mount-"));
    const { createAgentToolset } = await import("../agent/tools.js");
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
    const workerRead = worker.dynamicRunner
      .currentDefinitions()
      .find((d) => d.name === "read_file");
    expect(workerRead?.description ?? "").not.toContain("archive:///");
    await worker.dispose();

    const primary = await createAgentToolset({
      cwd,
      permissionGate,
      onOperatorGate: async () => ({ kind: "option", index: 0 }),
      getEvidenceArchive: () => undefined,
    });
    const primaryNames = primary.dynamicRunner.currentDefinitions().map((d) => d.name);
    expect(primaryNames).not.toContain("search_archive");
    expect(primaryNames).not.toContain("read_archive");
    const primaryRead = primary.dynamicRunner
      .currentDefinitions()
      .find((d) => d.name === "read_file");
    expect(primaryRead?.description).toContain("archive:///");
    const primaryGrep = primary.dynamicRunner.currentDefinitions().find((d) => d.name === "grep");
    expect(primaryGrep?.description).toContain("archive:///");
    const primarySearch = primary.dynamicRunner
      .currentDefinitions()
      .find((d) => d.name === "search_files");
    expect(primarySearch?.description).toContain("archive:///");
    await primary.dispose();
  });
});
