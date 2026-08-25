/**
 * Pure read/edit bookkeeping for dispatched workers, consumed by
 * evaluateSubAgentStop's requireEvidence check (CritiqueDirector). Reads
 * performed through run_shell count as evidence too — the prompt
 * prohibits shell file work, but a prompt violation deserves a correction,
 * not a verdict that the work never happened. `editedPaths` (from typed write
 * tools only) is diagnostics for interventions.jsonl; no stop decision
 * depends on it. Cancel/incomplete salvage also lists these paths via
 * salvagePathsFromThrash so the parent keeps file evidence when the leaf
 * is force-stopped.
 */

import { isProductMutationTool, productMutationPaths } from "../agent/product-mutation-tools.js";
import { PATH_KEYED_READ_TOOLS, SEARCH_QUERY_TOOLS } from "../agent/tool-classification.js";
import { classifyShellFileEvidence } from "./shell-evidence.js";

/** Accumulated read/edit bookkeeping across turns (immutable snapshots). */
export interface ThrashState {
  readonly readCounts: ReadonlyMap<string, number>;
  readonly editedPaths: ReadonlySet<string>;
  readonly totalToolCalls: number;
}

export const EMPTY_THRASH_STATE: ThrashState = {
  readCounts: new Map(),
  editedPaths: new Set(),
  totalToolCalls: 0,
};

/** Cap on Paths lines rendered into a forced-stop salvage report. */
export const SALVAGE_PATHS_CAP = 40;

/** Content block shape compatible with fingerprintToolCalls / inference turns. */
export interface ThrashToolCallBlock {
  type: string;
  name?: string;
  arguments?: unknown;
}

// list_dir is deliberately excluded: a repeated identical listing of the same
// directory is not the stuck read/search loop this bookkeeping watches for
// the way a repeated read_file or grep is (see tool-classification.ts).
const READ_TOOLS = PATH_KEYED_READ_TOOLS;
const SEARCH_TOOLS = SEARCH_QUERY_TOOLS;
const SHELL_TOOL = "run_shell";

function parseArgs(raw: unknown): Record<string, unknown> {
  let args: unknown = raw ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      return {};
    }
  }
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

function pathFromArgs(args: Record<string, unknown>): string | null {
  const path = args.path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

function searchKey(name: string, args: Record<string, unknown>): string {
  const pattern =
    typeof args.pattern === "string"
      ? args.pattern
      : typeof args.query === "string"
        ? args.query
        : "";
  const path = typeof args.path === "string" ? args.path : "";
  return `${name}::${pattern}::${path}`;
}

/**
 * Read-tracking key for a path. Chunked reads (offset/limit set) key by chunk,
 * a whole-file read keys by path alone.
 */
function readKey(path: string, args: Record<string, unknown>): string {
  const { offset, limit } = args;
  if (offset === undefined && limit === undefined) return path;
  return `${path}::${String(offset ?? 0)}:${String(limit ?? "")}`;
}

/**
 * Advance read/edit bookkeeping from one turn's content (or an explicit tool
 * list). Only `tool_call` blocks are counted; path strings are used as given
 * (no resolve).
 */
export function nextThrashState(
  prev: ThrashState,
  content: readonly ThrashToolCallBlock[],
): ThrashState {
  let totalToolCalls = prev.totalToolCalls;
  let readCounts: Map<string, number> | null = null;
  let editedPaths: Set<string> | null = null;

  for (const block of content) {
    if (block.type !== "tool_call") continue;
    totalToolCalls += 1;
    const name = typeof block.name === "string" ? block.name : "";
    const args = parseArgs(block.arguments);
    const path = pathFromArgs(args);

    if (READ_TOOLS.has(name) && path !== null) {
      if (readCounts === null) readCounts = new Map(prev.readCounts);
      const key = readKey(path, args);
      readCounts.set(key, (readCounts.get(key) ?? 0) + 1);
    } else if (SEARCH_TOOLS.has(name)) {
      if (readCounts === null) readCounts = new Map(prev.readCounts);
      const key = searchKey(name, args);
      readCounts.set(key, (readCounts.get(key) ?? 0) + 1);
    } else if (name === SHELL_TOOL) {
      // Shell reads are evidence too — the prompt prohibits shell
      // file work, but a prompt violation deserves a correction, not a
      // verdict that the work never happened.
      const command = args.command;
      if (typeof command === "string" && command.length > 0) {
        const evidence = classifyShellFileEvidence(command);
        if (evidence.reads.length > 0) {
          if (readCounts === null) readCounts = new Map(prev.readCounts);
          for (const key of evidence.reads) {
            readCounts.set(key, (readCounts.get(key) ?? 0) + 1);
          }
        }
      }
    } else if (isProductMutationTool(name)) {
      const paths = productMutationPaths(name, args);
      if (paths.length > 0) {
        if (editedPaths === null) editedPaths = new Set(prev.editedPaths);
        for (const edited of paths) editedPaths.add(edited);
      }
    }
  }

  if (totalToolCalls === prev.totalToolCalls && readCounts === null && editedPaths === null) {
    return prev;
  }

  return {
    readCounts: readCounts ?? prev.readCounts,
    editedPaths: editedPaths ?? prev.editedPaths,
    totalToolCalls,
  };
}

/**
 * Recover a filesystem path from a thrash readCounts key. Chunked reads
 * (`path::offset:limit`) collapse to `path`; search keys contribute their
 * scoped path segment when present; bare `shell:program` keys are skipped.
 */
function pathFromReadKey(key: string): string | null {
  if (key.startsWith("shell:")) return null;
  if (key.startsWith("grep::") || key.startsWith("search_files::")) {
    const parts = key.split("::");
    const scoped = parts[2];
    return scoped !== undefined && scoped.length > 0 ? scoped : null;
  }
  const chunkSep = key.indexOf("::");
  if (chunkSep === -1) return key.length > 0 ? key : null;
  const path = key.slice(0, chunkSep);
  return path.length > 0 ? path : null;
}

/**
 * Edited then read paths for a forced-stop Paths section. Deduped, edited
 * first, capped so a thrashing leaf cannot flood the parent report.
 */
export function salvagePathsFromThrash(
  state: ThrashState,
  cap: number = SALVAGE_PATHS_CAP,
): string[] {
  const limit = Math.max(0, Math.floor(cap));
  if (limit === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (path: string): void => {
    if (out.length >= limit) return;
    if (seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };
  for (const edited of state.editedPaths) {
    if (edited.length > 0) push(edited);
    if (out.length >= limit) return out;
  }
  for (const key of state.readCounts.keys()) {
    const path = pathFromReadKey(key);
    if (path !== null) push(path);
    if (out.length >= limit) return out;
  }
  return out;
}
