/**
 * On-disk trace reader backing the `read_agent_trace` fleet verb.
 *
 * Workers write their turn history to segmented `turns.jsonl` under their
 * workdir, but nothing in the runtime reads it back, so a cancelled or
 * interrupted worker's completed work stays invisible to the orchestrator.
 * This reads it directly, independent of the in-memory SubAgentSessionStore
 * (which a restart or killed worker can leave empty).
 *
 * Every read is bounded on four axes — turn window, entry count, per-entry
 * chars, total output chars — each with a hard maximum, so no argument
 * combination pulls an unbounded blob into the parent's context.
 */

import fs from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import path, { join } from "node:path";

import { listSegmentFiles } from "../session/incremental-jsonl.js";

const TURNS_FILE = "turns.jsonl";

export const DEFAULT_TRACE_TURN_WINDOW = 40;
export const MAX_TRACE_TURN_WINDOW = 200;
export const DEFAULT_TRACE_ENTRY_LIMIT = 200;
export const MAX_TRACE_ENTRY_LIMIT = 500;
export const MAX_TRACE_ENTRY_CHARS = 4_000;
// The per-axis caps multiply (500 × 4,000 = 2,000,000 chars); this caps
// the total.
export const MAX_TRACE_TOTAL_CHARS = 20_000;

// Bound the walk: a worker this deep or a fleet this large is itself a
// signal something upstream is wrong.
const MAX_SEARCH_DIRS = 4_000;
const MAX_SEARCH_DEPTH = 16;

export type TraceEntryKind =
  | "text"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "error";

export interface TraceEntry {
  turn: number;
  role: string;
  kind: TraceEntryKind;
  name?: string;
  callId?: string;
  isError?: boolean;
  content: string;
  truncated?: boolean;
}

export interface TraceOmission {
  reason: string;
  turnsBefore: number;
  turnsAfter: number;
  hint: string;
}

export interface TraceReadResult {
  agentId: string;
  totalTurns: number;
  fromTurn: number;
  toTurn: number;
  entries: TraceEntry[];
  entriesTruncated: boolean;
  parseWarnings: number;
  omitted: TraceOmission | null;
}

export interface TraceReadOptions {
  kinds?: readonly TraceEntryKind[];
  fromTurn?: number;
  toTurn?: number;
  limit?: number;
}

export class AgentTraceNotFoundError extends Error {
  constructor(target: string) {
    super(
      `No on-disk trace found for agent "${target}". It may not exist, may not have started ` +
        "writing turns yet, or may belong to a different fleet than the one you can see.",
    );
    this.name = "AgentTraceNotFoundError";
  }
}

interface DirEntry {
  name: string;
  path: string;
}

/**
 * Subdirectories of `dir`, symlinks resolved and de-duplicated by real path:
 * a `latest` symlink pointing at a sibling would otherwise be visited twice.
 * `name` is the resolved path's basename, so an alias and its target share
 * one canonical name.
 */
export async function listUniqueSubdirs(dir: string): Promise<DirEntry[]> {
  let entries: fs.Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const result: DirEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    let real: string;
    try {
      real = await realpath(full);
    } catch {
      continue; // broken symlink
    }
    if (seen.has(real)) continue;
    seen.add(real);
    result.push({ name: path.basename(real), path: real });
  }
  return result;
}

/**
 * Locate `targetId`'s trace directory under the `subagents/` tree at any
 * depth; a shallower match wins, keeping the search deterministic.
 */
export async function findAgentTraceDir(
  rootWorkdirBase: string,
  targetId: string,
): Promise<string | null> {
  let scanned = 0;

  async function walk(dir: string, depth: number): Promise<string | null> {
    if (depth > MAX_SEARCH_DEPTH) return null;
    const children = await listUniqueSubdirs(join(dir, "subagents"));

    for (const child of children) {
      scanned += 1;
      if (scanned > MAX_SEARCH_DIRS) return null;
      if (child.name === targetId) return child.path;
    }
    for (const child of children) {
      const nested = await walk(child.path, depth + 1);
      if (nested !== null) return nested;
    }
    return null;
  }

  return walk(rootWorkdirBase, 0);
}

interface RawTurn {
  role: string;
  content: unknown[];
}

function isRawTurn(value: unknown): value is RawTurn {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { role?: unknown }).role === "string" &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

/**
 * Tolerant line-oriented parse: the file is appended live while we read, so
 * a torn or malformed line is skipped, not thrown. Stale null bytes are
 * stripped first (same as optimized-context-store.ts on resume).
 */
function parseTurnsTolerant(text: string): {
  turns: RawTurn[];
  warnings: number;
} {
  const cleaned = text.includes("\0") ? text.replaceAll("\0", "") : text;
  if (cleaned.length === 0) return { turns: [], warnings: 0 };
  const lines = cleaned.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  const turns: RawTurn[] = [];
  let warnings = 0;
  for (const line of lines) {
    if (line.length === 0) continue;
    try {
      const raw: unknown = JSON.parse(line);
      if (isRawTurn(raw)) turns.push(raw);
      else warnings += 1;
    } catch {
      warnings += 1;
    }
  }
  return { turns, warnings };
}

/**
 * Read and parse every segment before the caller's bounds apply, so an
 * active, not-yet-rotated segment loads whole. Segments are capped at
 * ~256KB by the writer, so this cannot grow with total history the way one
 * big turns.jsonl could.
 */
async function readAllTurns(
  dir: string,
): Promise<{ turns: RawTurn[]; warnings: number }> {
  const segments = await listSegmentFiles(dir, TURNS_FILE);
  const turns: RawTurn[] = [];
  let warnings = 0;
  for (const name of segments) {
    let text: string;
    try {
      text = await fs.promises.readFile(join(dir, name), "utf-8");
    } catch {
      continue;
    }
    const parsed = parseTurnsTolerant(text);
    turns.push(...parsed.turns);
    warnings += parsed.warnings;
  }
  return { turns, warnings };
}

function truncateContent(text: string): {
  content: string;
  truncated: boolean;
} {
  if (text.length <= MAX_TRACE_ENTRY_CHARS)
    return { content: text, truncated: false };
  return { content: text.slice(0, MAX_TRACE_ENTRY_CHARS), truncated: true };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function toolResultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = block as { type?: unknown; text?: unknown };
      if (b?.type === "text" && typeof b.text === "string") return b.text;
      return `[${typeof b?.type === "string" ? b.type : "unknown"} block]`;
    })
    .join("\n");
}

function blockToEntry(
  turnIndex: number,
  role: string,
  block: unknown,
): TraceEntry | null {
  const b = block as { type?: unknown } & Record<string, unknown>;
  switch (b?.type) {
    case "text": {
      const { content, truncated } = truncateContent(
        typeof b.text === "string" ? b.text : "",
      );
      return {
        turn: turnIndex,
        role,
        kind: "text",
        content,
        ...(truncated && { truncated }),
      };
    }
    case "thinking": {
      const { content, truncated } = truncateContent(
        typeof b.thinking === "string" ? b.thinking : "",
      );
      return {
        turn: turnIndex,
        role,
        kind: "thinking",
        content,
        ...(truncated && { truncated }),
      };
    }
    case "tool_call": {
      const { content, truncated } = truncateContent(
        safeStringify(b.arguments),
      );
      return {
        turn: turnIndex,
        role,
        kind: "tool_call",
        ...(typeof b.name === "string" && { name: b.name }),
        ...(typeof b.id === "string" && { callId: b.id }),
        content,
        ...(truncated && { truncated }),
      };
    }
    case "tool_result": {
      const isError = b.isError === true;
      const { content, truncated } = truncateContent(toolResultText(b.content));
      return {
        turn: turnIndex,
        role,
        kind: isError ? "error" : "tool_result",
        ...(typeof b.callId === "string" && { callId: b.callId }),
        isError,
        content,
        ...(truncated && { truncated }),
      };
    }
    case "refusal": {
      const { content, truncated } = truncateContent(
        typeof b.reason === "string" ? b.reason : "",
      );
      return {
        turn: turnIndex,
        role,
        kind: "error",
        content,
        ...(truncated && { truncated }),
      };
    }
    default:
      return null;
  }
}

/**
 * Read a bounded slice of one worker's on-disk trace. Defaults to the most
 * recent `DEFAULT_TRACE_TURN_WINDOW` turns; caps have hard maxima. `omitted`
 * describes what was left out and how to fetch it on follow-up calls.
 */
export async function readAgentTrace(
  rootWorkdirBase: string,
  target: string,
  options: TraceReadOptions = {},
): Promise<TraceReadResult> {
  const dir = await findAgentTraceDir(rootWorkdirBase, target);
  if (dir === null) throw new AgentTraceNotFoundError(target);

  const { turns, warnings } = await readAllTurns(dir);
  const totalTurns = turns.length;

  const toTurn = Math.min(
    Math.max(options.toTurn ?? totalTurns, 0),
    totalTurns,
  );
  let fromTurn = Math.min(
    Math.max(
      options.fromTurn ?? Math.max(0, toTurn - DEFAULT_TRACE_TURN_WINDOW),
      0,
    ),
    toTurn,
  );
  const maxWindow = MAX_TRACE_TURN_WINDOW;
  if (toTurn - fromTurn > maxWindow) fromTurn = toTurn - maxWindow;

  const kindsFilter =
    options.kinds !== undefined ? new Set(options.kinds) : null;
  const limit = Math.min(
    Math.max(options.limit ?? DEFAULT_TRACE_ENTRY_LIMIT, 1),
    MAX_TRACE_ENTRY_LIMIT,
  );

  const entries: TraceEntry[] = [];
  let entriesTruncated = false;
  let totalChars = 0;
  let stopReason: "entry-limit" | "total-chars" | null = null;
  let lastReadTurn = fromTurn;
  outer: for (let i = fromTurn; i < toTurn; i++) {
    lastReadTurn = i;
    const turn = turns[i];
    if (turn === undefined) continue;
    for (const block of turn.content) {
      const entry = blockToEntry(i, turn.role, block);
      if (entry === null) continue;
      if (kindsFilter !== null && !kindsFilter.has(entry.kind)) continue;
      if (entries.length >= limit) {
        entriesTruncated = true;
        stopReason = "entry-limit";
        break outer;
      }
      if (totalChars + entry.content.length > MAX_TRACE_TOTAL_CHARS) {
        entriesTruncated = true;
        stopReason = "total-chars";
        break outer;
      }
      totalChars += entry.content.length;
      entries.push(entry);
    }
  }
  // Stopped mid-window: only turns before lastReadTurn were fully read.
  const readThrough = entriesTruncated ? lastReadTurn : toTurn;

  const turnsBefore = fromTurn;
  const turnsAfter = totalTurns - readThrough;
  const omitted: TraceOmission | null =
    turnsBefore > 0 || turnsAfter > 0
      ? {
          reason:
            stopReason === "entry-limit"
              ? "entry limit reached before the requested turn range finished reading"
              : stopReason === "total-chars"
                ? `total output cap (${MAX_TRACE_TOTAL_CHARS} chars) reached before the requested turn range finished reading`
                : "turn window bounded to the default/requested range",
          turnsBefore,
          turnsAfter,
          hint:
            turnsBefore > 0
              ? `call again with toTurn=${fromTurn} to page backward (totalTurns=${totalTurns})`
              : `call again with fromTurn=${readThrough} to page forward (totalTurns=${totalTurns})`,
        }
      : null;

  return {
    agentId: target,
    totalTurns,
    fromTurn,
    toTurn,
    entries,
    entriesTruncated,
    parseWarnings: warnings,
    omitted,
  };
}
