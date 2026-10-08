/**
 * Shared tool-name classification constants. One name (`READ_TOOLS`) used to
 * mean different memberships in four places, one of them security-relevant,
 * so the concepts are now separate sets derived from one base:
 *   - the director read surface (tool-sets.ts READ_TOOLS): everything a
 *     read-only leaf may call, including run_shell and the web tools;
 *   - the auto-allow gate: never needs an approval prompt — a strict subset
 *     (shell/web keep their own narrower rules) plus manage_tasks;
 *   - compaction's re-read dedup and thrash's read tracking: both key off
 *     read_file's path-keyed result, unified here.
 * Sets stay separate where the concepts differ, so a future difference reads
 * as intentional instead of drift.
 */

import { READ_TOOLS as DIRECTOR_READ_TOOLS } from "./directors/tool-sets.js";

/**
 * The one read tool whose result is keyed by path: a newer read supersedes
 * an older one for the same path. Shared by compaction's re-read dedup and
 * thrash's read-count bookkeeping.
 */
export const PATH_KEYED_READ_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
]);

/**
 * grep / search_files: pattern-keyed query tools — a repeated identical call
 * reflects current workspace state, not stale history. Base for compaction
 * and thrash; each adds/omits list_dir for its own reason.
 */
export const SEARCH_QUERY_TOOLS: ReadonlySet<string> = new Set([
  "grep",
  "search_files",
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
