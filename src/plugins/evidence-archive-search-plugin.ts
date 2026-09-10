import type { ToolDefinition } from "@intx/types/runtime";
import type { ToolPlugin } from "@intx/tools-posix";

import { READ_FILE_DEFAULT_MAX_LINES, readBytesBounded } from "./read-file-guard-plugin.js";
import type { CompactionArchive } from "../session/compaction-archive.js";
import type { ArchiveOccurrence } from "../session/compaction-archive-schema.js";
import { formatArchiveRef, isArchiveLike, parseArchiveTarget } from "../session/archive-uri.js";

const SEARCH_DEFAULT_MAX = 1000;
const GREP_DEFAULT_MAX = 500;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function globToRegExp(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern.charAt(i);
    if (c === "*" && pattern[i + 1] === "*") {
      i += 2;
      if (pattern[i] === "/") {
        i++;
        regex += "(?:.+/)?";
      } else {
        regex += ".*";
      }
    } else if (c === "*") {
      regex += "[^/]*";
      i++;
    } else if (c === "?") {
      regex += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(c)) {
      regex += `\\${c}`;
      i++;
    } else {
      regex += c;
      i++;
    }
  }
  return new RegExp(`^${regex}$`);
}

function matchesArchiveName(pattern: string, occ: ArchiveOccurrence): boolean {
  const matcher = globToRegExp(pattern);
  return (
    matcher.test(occ.occurrenceId) ||
    matcher.test(formatArchiveRef(occ.occurrenceId)) ||
    matcher.test(occ.kind)
  );
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
  return [
    occ.occurrenceId,
    occ.kind,
    occ.callId ?? "",
    occ.lifecycle ?? "",
    occ.provenance ?? "",
  ].join(" ");
}

function patchPathDescription(
  definition: ToolDefinition,
  pathDescription: string,
  toolDescription: string,
): ToolDefinition {
  const schema = definition.inputSchema;
  const props = schema["properties"];
  if (props === undefined || typeof props !== "object" || props === null) return definition;
  const properties = props as Record<string, unknown>;
  const pathSchema = properties.path;
  const nextPath =
    pathSchema !== undefined && typeof pathSchema === "object" && pathSchema !== null
      ? { ...(pathSchema as Record<string, unknown>), description: pathDescription }
      : { type: "string", description: pathDescription };
  return {
    ...definition,
    description: toolDescription,
    inputSchema: {
      ...schema,
      properties: {
        ...properties,
        path: nextPath,
      },
    },
  };
}

export function advertiseArchiveSurface(definition: ToolDefinition): ToolDefinition {
  if (definition.name === "read_file") {
    return patchPathDescription(
      definition,
      "Absolute or relative filesystem path, tool-output:///{callId}, or archive:///{occurrenceId}",
      `${definition.description} The path argument also accepts archive:///{occurrenceId} from search_files or grep on path archive:///.`,
    );
  }
  if (definition.name === "grep") {
    return patchPathDescription(
      definition,
      "File or directory to search in, or archive:/// for this session's evidence archive",
      `${definition.description} Pass path archive:/// to search compaction evidence; follow a hit with read_file on the archive:/// ref.`,
    );
  }
  if (definition.name === "search_files") {
    return patchPathDescription(
      definition,
      "Directory to search in, or archive:/// for this session's evidence-archive occurrence refs",
      `${definition.description} Pass path archive:/// to list evidence-archive refs.`,
    );
  }
  return definition;
}

export function evidenceArchiveSearchPlugin(
  getArchive: () => CompactionArchive | undefined,
): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      if (call.name !== "read_file" && call.name !== "grep" && call.name !== "search_files") {
        return next(call, signal);
      }
      const path = str(call.arguments.path);
      if (path === undefined || !isArchiveLike(path)) return next(call, signal);

      const archive = getArchive();
      if (archive === undefined) {
        return {
          callId: call.id,
          content: "Error: evidence archive is not available in this session.",
          isError: true,
        };
      }

      const target = parseArchiveTarget(path);
      if (target === undefined) return next(call, signal);

      try {
        if (call.name === "read_file") {
          return {
            callId: call.id,
            content: await readArchiveOccurrence(
              archive,
              target.occurrenceId,
              call.arguments,
              signal,
            ),
          };
        }
        if (call.name === "search_files") {
          const pattern = str(call.arguments.pattern);
          if (pattern === undefined) {
            return {
              callId: call.id,
              content: "Error: search_files requires pattern (string).",
              isError: true,
            };
          }
          const maxResults = num(call.arguments.max_results) ?? SEARCH_DEFAULT_MAX;
          return {
            callId: call.id,
            content: await searchArchiveFiles(
              archive,
              pattern,
              target.occurrenceId,
              maxResults,
              signal,
            ),
          };
        }
        const pattern = str(call.arguments.pattern);
        if (pattern === undefined) {
          return {
            callId: call.id,
            content: "Error: grep requires pattern (string).",
            isError: true,
          };
        }
        const maxResults = num(call.arguments.max_results) ?? GREP_DEFAULT_MAX;
        const glob = str(call.arguments.glob);
        const contextArg = num(call.arguments.context);
        const context = contextArg !== undefined && contextArg > 0 ? Math.floor(contextArg) : 0;
        return {
          callId: call.id,
          content: await grepArchive(
            archive,
            pattern,
            target.occurrenceId,
            maxResults,
            glob,
            context,
            signal,
          ),
        };
      } catch (err) {
        return {
          callId: call.id,
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

async function readArchiveOccurrence(
  archive: CompactionArchive,
  occurrenceId: string | undefined,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  if (occurrenceId === undefined) {
    throw new Error("read_file archive path must be archive:///{occurrenceId}");
  }
  const text = await archive.readAuthorizedPayload(occurrenceId);
  const offsetArg = num(args.offset);
  const offset = offsetArg !== undefined && offsetArg > 0 ? Math.floor(offsetArg) : 0;
  const limitArg = num(args.limit);
  const limit =
    limitArg !== undefined && limitArg > 0 ? Math.floor(limitArg) : READ_FILE_DEFAULT_MAX_LINES;
  const result = await readBytesBounded(
    new TextEncoder().encode(text),
    offset,
    limit,
    signal,
    formatArchiveRef(occurrenceId),
  );
  return result.content;
}

async function searchArchiveFiles(
  archive: CompactionArchive,
  pattern: string,
  occurrenceId: string | undefined,
  maxResults: number,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const occurrences = await selectOccurrences(archive, occurrenceId);
  const hits: string[] = [];
  for (const occ of occurrences) {
    signal.throwIfAborted();
    if (hits.length >= maxResults) break;
    if (!matchesArchiveName(pattern, occ)) continue;
    hits.push(formatArchiveRef(occ.occurrenceId));
  }
  if (hits.length === 0) {
    return `No evidence-archive occurrences matched "${pattern}".`;
  }
  return hits.join("\n");
}

function grepPayloadHits(
  ref: string,
  lines: string[],
  regex: RegExp,
  context: number,
  remaining: number,
): { lines: string[]; matchCount: number } {
  if (remaining <= 0) return { lines: [], matchCount: 0 };
  const matchLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i] ?? "")) matchLines.push(i);
    if (matchLines.length >= remaining) break;
  }
  if (matchLines.length === 0) return { lines: [], matchCount: 0 };
  if (context <= 0) {
    return {
      lines: matchLines.map((i) => `${ref}:${i + 1}:${lines[i] ?? ""}`),
      matchCount: matchLines.length,
    };
  }
  const matchSet = new Set(matchLines);
  const ranges: { start: number; end: number }[] = [];
  for (const i of matchLines) {
    const start = Math.max(0, i - context);
    const end = Math.min(lines.length - 1, i + context);
    const prev = ranges[ranges.length - 1];
    if (prev !== undefined && start <= prev.end + 1) {
      prev.end = end;
    } else {
      ranges.push({ start, end });
    }
  }
  const out: string[] = [];
  let first = true;
  for (const range of ranges) {
    if (!first) out.push("--");
    first = false;
    for (let i = range.start; i <= range.end; i++) {
      const sep = matchSet.has(i) ? ":" : "-";
      out.push(`${ref}${sep}${i + 1}${sep}${lines[i] ?? ""}`);
    }
  }
  return { lines: out, matchCount: matchLines.length };
}

async function grepArchive(
  archive: CompactionArchive,
  pattern: string,
  occurrenceId: string | undefined,
  maxResults: number,
  glob: string | undefined,
  context: number,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (err) {
    throw new Error(`invalid regex: ${err instanceof Error ? err.message : String(err)}`);
  }
  const occurrences = await selectOccurrences(archive, occurrenceId);
  const hits: string[] = [];
  let matchCount = 0;
  for (const occ of occurrences) {
    signal.throwIfAborted();
    if (matchCount >= maxResults) break;
    if (glob !== undefined && !matchesArchiveName(glob, occ)) continue;
    const ref = formatArchiveRef(occ.occurrenceId);
    if (regex.test(metadataBlob(occ))) {
      hits.push(`${ref}:1:${formatHit(occ)}`);
      matchCount++;
      continue;
    }
    if (occ.gap === true) continue;
    let payload: string;
    try {
      payload = await archive.readAuthorizedPayload(occ.occurrenceId);
    } catch (err) {
      if (signal.aborted) throw err;
      continue;
    }
    signal.throwIfAborted();
    const payloadHits = grepPayloadHits(
      ref,
      payload.split("\n"),
      regex,
      context,
      maxResults - matchCount,
    );
    hits.push(...payloadHits.lines);
    matchCount += payloadHits.matchCount;
  }
  if (hits.length === 0) return `no matches for /${pattern}/`;
  return hits.join("\n");
}

async function selectOccurrences(
  archive: CompactionArchive,
  occurrenceId: string | undefined,
): Promise<ArchiveOccurrence[]> {
  const occurrences = await archive.listOccurrences();
  if (occurrenceId === undefined) return occurrences;
  const hit = occurrences.find((occ) => occ.occurrenceId === occurrenceId);
  if (hit === undefined) throw new Error(`unknown occurrence ${occurrenceId}`);
  return [hit];
}
