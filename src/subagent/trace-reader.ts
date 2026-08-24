/**
 * On-disk trace reader backing the `read_agent_trace` fleet verb (CL-6951).
 *
 * Every sub-agent worker writes its full turn history to `turns.jsonl`
 * (segmented — see incremental-jsonl.ts) under its own workdir, but nothing
 * in the runtime reads it back. That means a cancelled or interrupted
 * worker's completed work — everything it did before it stopped — is
 * invisible to the orchestrator even though it is sitting on disk. This
 * module reads it directly, independent of the in-memory
 * SubAgentSessionStore (which a process restart or a killed worker can
 * leave with nothing).
 *
 * Every read here is bounded on four independent axes — turn window, entry
 * count, per-entry characters, and total output characters (the first three
 * multiply, so they are each capped again by a total-output ceiling) — each
 * with a hard maximum regardless of what the caller asks for. No argument
 * combination can pull an unbounded blob into the parent's context.
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
// Per-entry/entry-count/turn-window caps each bound one axis, but multiply
// together (500 entries * 4,000 chars = 2,000,000 chars in one call). This
// caps the total regardless of how the other axes are combined.
export const MAX_TRACE_TOTAL_CHARS = 20_000;

// A pathological or runaway fleet tree should fail the search cheaply rather
// than walk forever; a worker this deep or a fleet this large is itself a
// signal something upstream is wrong.
const MAX_SEARCH_DIRS = 4_000;
const MAX_SEARCH_DEPTH = 16;

export type TraceEntryKind = "text" | "thinking" | "tool_call" | "tool_result" | "error";

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
 * Subdirectories of `dir`, symlinks resolved and de-duplicated by real path.
 * A `latest`-style symlink pointing at a sibling entry would otherwise be
 * visited as a second, distinct directory by a naive `readdir` — every
 * enumeration in this module goes through here instead so that case can
 * never double-count. `name` is derived from the resolved real path's own
 * basename (not the raw dirent name), so a symlink alias and its target
 * always report the same canonical name no matter which one `readdir`
 * happens to return first.
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
 * Locate the trace directory for `targetId` under `rootWorkdirBase`'s
 * `subagents/` tree, at any depth. A shallower match wins over a deeper one
 * with the same name (there should never be two, since ids are generated
 * uuids, but shallowest-first keeps the search deterministic either way).
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
 * Tolerant line-oriented parse: a torn or malformed line (the file is being
 * appended to live while we read it) is skipped, not thrown. Null bytes from
 * a stale truncate-past-EOF are stripped first for the same reason
 * optimized-context-store.ts strips them on resume.
 */
function parseTurnsTolerant(text: string): { turns: RawTurn[]; warnings: number } {
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
 * Reads and parses every segment before the caller's window/limit bounds
 * apply, so a not-yet-rotated active segment is loaded whole regardless of
 * how small a slice the caller actually wants. In practice each segment is
 * itself bounded to ~256KB by the writer (createSegmentedJSONLWriter's
 * DEFAULT_MAX_SEGMENT_BYTES), so this cannot grow unboundedly with a
 * worker's total history the way reading turns.jsonl as one file could —
 * but avoiding this read entirely (only touching the segments the requested
 * turn range actually falls in) needs either a cheap line-count index or a
 * streaming reader, which is a larger change than this fix; tracked as a
 * follow-up rather than expanding this one.
 */
async function readAllTurns(dir: string): Promise<{ turns: RawTurn[]; warnings: number }> {
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

function truncateContent(text: string): { content: string; truncated: boolean } {
  if (text.length <= MAX_TRACE_ENTRY_CHARS) return { content: text, truncated: false };
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

function blockToEntry(turnIndex: number, role: string, block: unknown): TraceEntry | null {
  const b = block as { type?: unknown } & Record<string, unknown>;
  switch (b?.type) {
    case "text": {
      const { content, truncated } = truncateContent(typeof b.text === "string" ? b.text : "");
      return { turn: turnIndex, role, kind: "text", content, ...(truncated && { truncated }) };
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
      const { content, truncated } = truncateContent(safeStringify(b.arguments));
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
      const { content, truncated } = truncateContent(typeof b.reason === "string" ? b.reason : "");
      return { turn: turnIndex, role, kind: "error", content, ...(truncated && { truncated }) };
    }
    default:
      return null;
  }
}

/**
 * Read a bounded slice of one worker's on-disk trace. Defaults to the most
 * recent `DEFAULT_TRACE_TURN_WINDOW` turns; every window and entry cap has a
 * hard maximum the caller cannot exceed. `omitted` is populated whenever any
 * turns or entries were left out, with enough information (turn counts plus
 * a concrete hint) to fetch the rest across follow-up calls.
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

  const toTurn = Math.min(Math.max(options.toTurn ?? totalTurns, 0), totalTurns);
  let fromTurn = Math.min(
    Math.max(options.fromTurn ?? Math.max(0, toTurn - DEFAULT_TRACE_TURN_WINDOW), 0),
    toTurn,
  );
  const maxWindow = MAX_TRACE_TURN_WINDOW;
  if (toTurn - fromTurn > maxWindow) fromTurn = toTurn - maxWindow;

  const kindsFilter = options.kinds !== undefined ? new Set(options.kinds) : null;
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
    const turn = turns[i]!;
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
  // If we stopped mid-window, only turns strictly before lastReadTurn were
  // fully read; report the boundary honestly for the resume hint.
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
