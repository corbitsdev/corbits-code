/**
 * Shared tool-name classification constants.
 *
 * Three separate READ_TOOLS constants (director tool-sets, session compactor,
 * subagent thrash tracker) had drifted to different memberships under the
 * same name, and the permission auto-allow gate carried a fourth with no
 * declared relationship. Same name, different meanings, one security-relevant.
 *
 * These are different concepts, not one list typed four times:
 *   - the director read surface (tool-sets.ts READ_TOOLS) is "everything a
 *     read-only leaf may call", including run_shell and the web tools;
 *   - the auto-allow gate is "never needs an approval prompt", a strict
 *     subset (shell/web get their own narrower auto-allow logic) plus
 *     manage_tasks (side-effect-free);
 *   - compaction's re-read dedup and thrash's read tracking both care about
 *     read_file specifically, because its result is keyed by path — the same
 *     set twice, unified here.
 * Where the concepts differ, the sets stay separate, derived from the same
 * base and named for what they mean, so a future difference reads as
 * intentional instead of drift.
 */

import { READ_TOOLS as DIRECTOR_READ_TOOLS } from "./directors/tool-sets.js";

/**
 * read_file: the one read tool whose result is keyed by path, so an older
 * result for the same path is safely superseded by a newer one. Shared by
 * compaction's re-read dedup and thrash's read-count bookkeeping.
 */
export const PATH_KEYED_READ_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
]);

/**
 * grep / search_files: pattern-keyed query tools whose repeated identical
 * call reflects current workspace state, not stale history. The base both
 * compaction and thrash build on; each adds/omits list_dir for its own reason.
 */
export const SEARCH_QUERY_TOOLS: ReadonlySet<string> = new Set([
  "grep",
  "search_files",
]);

/**
 * Tools that never need an approval prompt because they cannot change the
 * workspace: the director's read surface minus run_shell/web_fetch/web_search
 * (which get their own narrower auto-allow rules) plus manage_tasks
 * (side-effect-free by the time the tool executes). SECURITY-RELEVANT: this
 * gates auto-allow. A tool added here is auto-approved everywhere; get it
 * wrong in either direction deliberately, not by accident.
 */
export const AUTO_ALLOW_READ_TOOLS: ReadonlySet<string> = new Set([
  ...DIRECTOR_READ_TOOLS.filter(
    (tool) =>
      tool !== "run_shell" && tool !== "web_fetch" && tool !== "web_search",
  ),
  "manage_tasks",
]);
