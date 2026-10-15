import { resolve } from "node:path";
import type { ToolPlugin } from "@intx/tools-posix";
import { isToolOutputLike } from "../util/tool-output-uri.js";
import { isArchiveLike } from "../session/compaction-archive.js";
import { resolveWorkspacePath } from "../permission/path-restriction.js";
import {
  realpathOrOriginal,
  type RootsProvider,
} from "../permission/worktree-roots.js";
import { canonicalToolName } from "../agent/canonical-tool-name.js";
import { denyResult, errorMessage, resolveAllowOutside } from "./tool-args.js";

export interface PathEscapeOptions {
  // When true (yolo / --dangerously-skip-permissions), paths outside the
  // workspace still resolve to absolute form and pass through. Secret-guard and
  // authz remain the hard-deny layers; the permission gate already auto-allows.
  // A getter is resolved per call so `/yolo` mid-session takes effect without
  // rebuilding the plugin stack.
  allowOutside?: boolean | (() => boolean);
  // Trusted plugin directories. Reads under these roots are not path-escape
  // denies (grants can still apply). Writes and deletes stay denied — plugin
  // trust is not write consent.
  trustedPluginRoots?: RootsProvider;
}

const PLUGIN_READ_TOOLS = new Set([
  "read_file",
  "grep",
  "search_files",
  "list_dir",
]);

function rootsForEscape(
  toolName: string,
  rootsProvider: RootsProvider,
  trustedPluginRoots?: RootsProvider,
): RootsProvider {
  if (
    trustedPluginRoots === undefined ||
    !PLUGIN_READ_TOOLS.has(canonicalToolName(toolName))
  ) {
    return rootsProvider;
  }
  return () => [
    ...rootsProvider(),
    ...trustedPluginRoots().map(realpathOrOriginal),
  ];
}

export function pathEscapePlugin(
  cwd: string,
  rootsProvider: RootsProvider = () => [],
  options: PathEscapeOptions = {},
): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      let escaped: Record<string, unknown>;
      try {
        escaped = escapeArgs(
          call.arguments,
          cwd,
          rootsProvider,
          resolveAllowOutside(options.allowOutside),
          call.name,
          options.trustedPluginRoots,
        );
      } catch (err) {
        return denyResult(call.id, errorMessage(err));
      }
      return next({ ...call, arguments: escaped }, signal);
    },
  };
}

function escapeArgs(
  args: Record<string, unknown>,
  cwd: string,
  rootsProvider: RootsProvider,
  allowOutside: boolean,
  toolName: string,
  trustedPluginRoots?: RootsProvider,
): Record<string, unknown> {
  // One fused walk: sanitizePath throws the same deny strings
  // pathEscapeBlockReason computes, so a surviving call is exactly one the
  // block-reason leg would have passed.
  const roots = rootsForEscape(toolName, rootsProvider, trustedPluginRoots);
  return walkPathArgs(args, undefined, (value) =>
    sanitizePath(value, cwd, roots, allowOutside, toolName),
  ) as Record<string, unknown>;
}

/**
 * Deep-walk shared by every path-argument pass: strings under path-keyed
 * arguments (innermost key wins; array entries inherit the array key) go to
 * `visit`, everything else passes through untouched.
 */
function walkPathArgs(
  value: unknown,
  key: string | undefined,
  visit: (value: string) => unknown,
): unknown {
  if (typeof value === "string") {
    return key !== undefined && looksLikePath(key) ? visit(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => walkPathArgs(entry, key, visit));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      out[entryKey] = walkPathArgs(entryValue, entryKey, visit);
    }
    return out;
  }
  return value;
}

// Explicit allowlist of argument keys treated as filesystem paths. Keys are
// matched case- and separator-insensitively, so `filePath`, `FILE_PATH`, and
// `file-path` all count alongside `file_path`; any key ending in
// `path`/`paths` (e.g. `somepath`, `outputPaths`) counts too, except query-
// language and JVM keys (`xpath`, `jsonpath`, `classpath` and their plurals)
// whose values are expressions, not filesystem paths. Anything else passes
// through untouched by design: MCP and custom tools may use arbitrary keys
// whose values only their server interprets, so unknown keys are that
// server's contract, not this sandbox's.
export function looksLikePath(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  if (
    normalized.endsWith("xpath") ||
    normalized.endsWith("xpaths") ||
    normalized.endsWith("jsonpath") ||
    normalized.endsWith("jsonpaths") ||
    normalized.endsWith("classpath") ||
    normalized.endsWith("classpaths")
  ) {
    return false;
  }
  return (
    normalized === "path" ||
    normalized === "paths" ||
    normalized === "filepath" ||
    normalized === "filepaths" ||
    normalized === "target" ||
    normalized === "cwd" ||
    normalized === "directory" ||
    normalized === "dir" ||
    normalized === "dest" ||
    normalized === "source" ||
    normalized === "from" ||
    normalized === "to" ||
    normalized === "filename" ||
    normalized === "filenames" ||
    normalized.endsWith("path") ||
    normalized.endsWith("paths")
  );
}

// Only read_file can consume a spilled tool-output blob; every other tool
// rejects the scheme in toolOutputUriPlugin. The sandbox skips containment
// for the same tool so a non-reader is denied here too instead of only by
// plugin order.
// archive:/// refs are served to read_file, grep, and search_files by
// evidenceArchiveSearchPlugin (see advertiseArchiveSurface); other tools have
// no archive reader, so the sandbox only skips containment for those three.
const TOOL_OUTPUT_URI_TOOL = "read_file";
const ARCHIVE_URI_TOOLS = new Set(["read_file", "grep", "search_files"]);

function toolOutputUriDenial(toolName: string, value: string): string {
  return `cannot ${toolName} a tool-output:// URI: ${value}. Use read_file with that URI to read the spilled output instead.`;
}

// "skip" when this tool may receive the virtual ref, a block message when it
// may not, undefined when the value is an ordinary filesystem path. An omitted
// toolName denies rather than skips: both production callers (the middleware
// and the permission gate) always pass a name, so an omission is a caller bug
// and must fail closed instead of silently skipping the deny.
export function virtualRefVerdict(
  value: string,
  toolName: string | undefined,
): "skip" | string | undefined {
  if (isToolOutputLike(value)) {
    if (toolName === TOOL_OUTPUT_URI_TOOL) {
      return "skip";
    }
    if (toolName === undefined) {
      return `cannot use a tool-output:// URI without a tool identity: ${value}. Use read_file with that URI to read the spilled output instead.`;
    }
    return toolOutputUriDenial(toolName, value);
  }
  if (isArchiveLike(value)) {
    if (toolName !== undefined && ARCHIVE_URI_TOOLS.has(toolName)) {
      return "skip";
    }
    if (toolName === undefined) {
      return `cannot use an archive:/// ref without a tool identity: ${value}. Only read_file, grep, and search_files accept archive:/// refs.`;
    }
    return `cannot ${toolName} an archive:/// ref: ${value}. Only read_file, grep, and search_files accept archive:/// refs.`;
  }
  return undefined;
}

// Same sandbox pathEscapePlugin enforces at execution. The permission gate
// consults this at authorize time so it can deny instead of asking for a call
// the plugin will reject after Accept.
export function pathEscapeBlockReason(
  args: Record<string, unknown>,
  cwd: string,
  rootsProvider: RootsProvider = () => [],
  toolName: string,
  trustedPluginRoots?: RootsProvider,
): string | undefined {
  return blockReasonFor(
    args,
    cwd,
    rootsForEscape(toolName, rootsProvider, trustedPluginRoots),
    undefined,
    toolName,
  );
}

// Deep-walk identity for the permission gate's authorize/execution cache.
// Same key propagation as escapeValue (innermost key wins; array entries
// inherit the array key), but non-throwing: in-bounds paths resolve to their
// workspace-absolute form while escapes and non-path values pass through
// untouched. Both cache sides compute it, so a fail-closed re-decide still
// agrees — the point is only that authorize-time relative and execution-time
// rewritten arguments share one identity.
export function normalizePathArguments(
  args: Record<string, unknown>,
  cwd: string,
  rootsProvider: RootsProvider = () => [],
  trustedPluginRoots?: RootsProvider,
): Record<string, unknown> {
  return normalizeValue(
    args,
    cwd,
    rootsForEscape("read_file", rootsProvider, trustedPluginRoots),
  );
}

function normalizeValue(
  args: Record<string, unknown>,
  cwd: string,
  rootsProvider: RootsProvider,
): Record<string, unknown> {
  return walkPathArgs(args, undefined, (value) => {
    if (isToolOutputLike(value) || isArchiveLike(value)) return value;
    return resolveWorkspacePath(cwd, value, rootsProvider) ?? value;
  }) as Record<string, unknown>;
}

function blockReasonFor(
  args: Record<string, unknown>,
  cwd: string,
  rootsProvider: RootsProvider,
  key: string | undefined,
  toolName: string,
): string | undefined {
  let reason: string | undefined = undefined;
  walkPathArgs(args, key, (value) => {
    if (reason !== undefined) return value;
    const verdict = virtualRefVerdict(value, toolName);
    if (verdict === "skip") return value;
    if (typeof verdict === "string") {
      reason = verdict;
      return value;
    }
    if (resolveWorkspacePath(cwd, value, rootsProvider) === undefined) {
      reason = `Path escapes working directory: ${value}`;
    }
    return value;
  });
  return reason;
}

function sanitizePath(
  value: string,
  cwd: string,
  rootsProvider: RootsProvider,
  allowOutside: boolean,
  toolName: string,
): string {
  const verdict = virtualRefVerdict(value, toolName);
  if (verdict === "skip") {
    return value;
  }
  if (typeof verdict === "string") {
    throw new Error(verdict);
  }
  const resolved = resolveWorkspacePath(cwd, value, rootsProvider);
  if (resolved !== undefined) {
    return resolved;
  }
  if (allowOutside) {
    // Same lexical resolve as resolveWorkspacePath's in-bounds branch — absolute
    // so later plugins see a stable path, not a relative escape fragment.
    return resolve(cwd, value);
  }
  throw new Error(`Path escapes working directory: ${value}`);
}
