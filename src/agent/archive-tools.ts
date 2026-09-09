import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";

import {
  READ_FILE_DEFAULT_MAX_LINES,
  readBytesBounded,
} from "../plugins/read-file-guard-plugin.js";
import type { CompactionArchive } from "../session/compaction-archive.js";
import type { ArchiveOccurrence } from "../session/compaction-archive-schema.js";
import { formatArchiveRef, parseArchiveRef } from "../session/archive-uri.js";

const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;

export const searchArchiveDefinition: ToolDefinition = {
  name: "search_archive",
  description:
    "Search this session's compaction evidence archive. Returns archive:///{occurrenceId} refs only — follow a hit with read_archive. Do not pass sessionId, path, or blobKey; do not read_file evidence-archive or tool-output/archive-* paths.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keywords to match against kind, call id, provenance, or payload text.",
      },
      limit: {
        type: "number",
        description: "Max hits to return (default 20, cap 50).",
      },
    },
    required: ["query"],
  },
};

export const readArchiveDefinition: ToolDefinition = {
  name: "read_archive",
  description:
    "Read one evidence-archive occurrence by archive:///{occurrenceId} from search_archive. Bounded like read_file (offset/limit). Do not pass sessionId, path, or blobKey.",
  inputSchema: {
    type: "object",
    properties: {
      ref: {
        type: "string",
        description: "An archive:///{occurrenceId} handle from search_archive.",
      },
      offset: {
        type: "number",
        description: "Zero-based line skip, same as read_file.",
      },
      limit: {
        type: "number",
        description: "Max lines to return.",
      },
    },
    required: ["ref"],
  },
};

const SearchArchiveArgs = type({
  query: "string",
  "limit?": "number",
});

const ReadArchiveArgs = type({
  ref: "string",
  "offset?": "number",
  "limit?": "number",
});

function forbiddenLocatorMessage(tool: string): string {
  return `Error: ${tool} does not accept sessionId, path, or blobKey. Use archive:///{occurrenceId} refs only.`;
}

function hasForbiddenLocatorArgs(rawArgs: Record<string, unknown>): boolean {
  return "sessionId" in rawArgs || "path" in rawArgs || "blobKey" in rawArgs;
}

function formatHit(occ: ArchiveOccurrence): string {
  const parts = [formatArchiveRef(occ.occurrenceId), occ.kind];
  if (occ.callId !== undefined) parts.push(`callId=${occ.callId}`);
  if (occ.lifecycle !== undefined) parts.push(`lifecycle=${occ.lifecycle}`);
  if (occ.provenance !== undefined) parts.push(`provenance=${occ.provenance}`);
  if (occ.gap === true) parts.push("gap");
  return parts.join("  ");
}

function metadataBlob(occ: ArchiveOccurrence): string {
  return [occ.occurrenceId, occ.kind, occ.callId ?? "", occ.lifecycle ?? "", occ.provenance ?? ""]
    .join(" ")
    .toLowerCase();
}

export function createSearchArchiveTool(
  getArchive: () => CompactionArchive | undefined,
): AgentTool {
  return stringTool({
    definition: searchArchiveDefinition,
    handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
      if (hasForbiddenLocatorArgs(rawArgs)) return forbiddenLocatorMessage("search_archive");
      const parsed = SearchArchiveArgs(rawArgs);
      if (parsed instanceof type.errors) {
        return "Error: search_archive requires query (string).";
      }
      const archive = getArchive();
      if (archive === undefined) {
        return "Error: evidence archive is not available in this session.";
      }
      const query = parsed.query.trim().toLowerCase();
      const limitRaw = parsed.limit;
      const limit =
        typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
          ? Math.min(Math.floor(limitRaw), SEARCH_MAX_LIMIT)
          : SEARCH_DEFAULT_LIMIT;
      const occurrences = await archive.listOccurrences();
      const hits: string[] = [];
      for (const occ of occurrences) {
        if (hits.length >= limit) break;
        if (query.length === 0 || metadataBlob(occ).includes(query)) {
          hits.push(formatHit(occ));
          continue;
        }
        if (occ.gap === true) continue;
        try {
          const payload = await archive.readAuthorizedPayload(occ.occurrenceId);
          if (payload.toLowerCase().includes(query)) hits.push(formatHit(occ));
        } catch {
          continue;
        }
      }
      if (hits.length === 0) {
        return query.length === 0
          ? "No evidence-archive occurrences are recorded yet."
          : `No evidence-archive occurrences matched "${parsed.query.trim()}".`;
      }
      return [
        "Matching evidence-archive occurrences (pass ref to read_archive):",
        "",
        ...hits,
      ].join("\n");
    },
  });
}

export function createReadArchiveTool(getArchive: () => CompactionArchive | undefined): AgentTool {
  return stringTool({
    definition: readArchiveDefinition,
    handler: async (rawArgs: Record<string, unknown>, signal: AbortSignal): Promise<string> => {
      if (hasForbiddenLocatorArgs(rawArgs)) return forbiddenLocatorMessage("read_archive");
      const parsed = ReadArchiveArgs(rawArgs);
      if (parsed instanceof type.errors) {
        return "Error: read_archive requires ref (archive:///{occurrenceId}).";
      }
      const occurrenceId = parseArchiveRef(parsed.ref.trim());
      if (occurrenceId === undefined) {
        return "Error: read_archive ref must be archive:///{occurrenceId}.";
      }
      const archive = getArchive();
      if (archive === undefined) {
        return "Error: evidence archive is not available in this session.";
      }
      const offset =
        typeof parsed.offset === "number" && parsed.offset > 0 ? Math.floor(parsed.offset) : 0;
      const limit =
        typeof parsed.limit === "number" && parsed.limit > 0
          ? Math.floor(parsed.limit)
          : READ_FILE_DEFAULT_MAX_LINES;
      try {
        const text = await archive.readAuthorizedPayload(occurrenceId);
        const bytes = new TextEncoder().encode(text);
        const display = formatArchiveRef(occurrenceId);
        const result = await readBytesBounded(bytes, offset, limit, signal, display);
        return result.content;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
