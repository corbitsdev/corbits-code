/**
 * Shared tool-name classification constants. One name (`READ_TOOLS`) used to
 * mean different memberships in four places, one of them security-relevant,
 * so the concepts are now separate sets derived from one base: the director
 * read surface (tool-sets.ts READ_TOOLS), the auto-allow gate, and the
 * path-keyed / query-keyed sets behind compaction's dedup and thrash's
 * read tracking. Sets stay separate where the concepts differ, so a future
 * difference reads as intentional instead of drift.
 */

import { READ_TOOLS as DIRECTOR_READ_TOOLS } from "./directors/tool-sets.js";

/**
 * The read tool whose result is keyed by path: a newer read supersedes an
 * older one for the same path. Shared by compaction's re-read dedup and
 * thrash's read tracking.
 */
export const PATH_KEYED_READ_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
]);

/**
 * grep / search_files: pattern-keyed query tools — a repeated identical call
 * reflects the current workspace, not stale history. Base for compaction
 * and thrash; each adds/omits list_dir for its own reason.
 */
export const SEARCH_QUERY_TOOLS: ReadonlySet<string> = new Set([
  "grep",
  "search_files",
]);

/**
 * Tools whose call a recovery may replay without repeating a side effect:
 * path-keyed reads, search queries, and web reads. Deliberately narrow and
 * closed: run_shell, writes, MCP, and any tool not named here make a failed
 * run ineligible for enforced recovery.
 */
export const REPLAY_SAFE_TOOLS: ReadonlySet<string> = new Set([
  ...PATH_KEYED_READ_TOOLS,
  ...SEARCH_QUERY_TOOLS,
  "web_fetch",
  "web_search",
]);

/**
 * Tools that never need an approval prompt (cannot change the workspace):
 * the director's read surface minus run_shell/web_fetch/web_search, which
 * have their own narrower auto-allow rules, plus manage_tasks.
 * SECURITY-RELEVANT: a tool added here is auto-approved everywhere; make
 * membership changes deliberately, not by accident.
 */
export const AUTO_ALLOW_READ_TOOLS: ReadonlySet<string> = new Set([
  ...DIRECTOR_READ_TOOLS.filter(
    (tool) =>
      tool !== "run_shell" && tool !== "web_fetch" && tool !== "web_search",
  ),
  "manage_tasks",
]);

/**
 * Read-only control-plane lookups. They read this agent's own catalogs or
 * worker records and cannot change the workspace or grant authority, so
 * classifyTool allows them in every mode, including non-auto interactive
 * sessions that are not yolo. Mutating and authority-granting control-plane
 * verbs are absent on purpose. gate.ts lists every control-plane verb and
 * its non-auto, non-yolo effect next to that allow.
 * SECURITY-RELEVANT: a name added here never prompts.
 */
export const READ_ONLY_CONTROL_PLANE_TOOLS: ReadonlySet<string> = new Set([
  "tool_search",
  "search_agents",
  "list_agents",
  "read_agent_trace",
]);
