/** Corbits Code-local timeout copy for search/read guards. Do not patch interchange. */

import { resolve as resolvePath } from "node:path";

export type ScopedSearchTool = "grep" | "search_files";

export const TIMEOUT_PREFIX = "[timed out before completing]";

export function scopedSearchRetryHints(tool: ScopedSearchTool): string {
  const base =
    "Scope to a subdirectory (narrow `path`), add a `glob` filter, or use a more specific pattern";
  if (tool === "grep") {
    return `${base}; a shorter regex also reduces work`;
  }
  return `${base}; a tighter glob pattern also reduces work`;
}

export function formatSearchTimeoutMessage(
  tool: ScopedSearchTool,
  partialResult?: string,
): string {
  const notice =
    `${tool} ${TIMEOUT_PREFIX} — ${scopedSearchRetryHints(tool)}. ` +
    `This is not the same as "no matches".`;
  const trimmed = partialResult?.trim();
  if (trimmed === undefined || trimmed.length === 0) return notice;
  return `${trimmed}\n\n${notice}`;
}

// A search_files pattern that has no bound on where a match can begin is a
// whole-tree walk: bare stars, or a recursive descent that starts at the root
// with nothing literal before it. A literal path segment before the first `**`
// (`src/**/*.ts`) pins the walk to that subtree, so it is bounded even though
// it recurses. Tighter globs (`*.ts`, `*config*`) still match a bounded name
// space and stay allowed at the root.
export function isUnboundedSearchGlob(pattern: string): boolean {
  if (pattern === "*") return true;
  const firstRecursive = pattern.indexOf("**");
  if (firstRecursive === -1) return false;
  // Everything before the first `**` is only wildcard descent and separators,
  // so the walk still reaches every file from the root.
  return !hasLiteralBefore(pattern.slice(0, firstRecursive));
}

// True when the pre-`**` prefix collapses to a real, name-bearing directory
// that anchors the walk away from the workspace root. The prefix is split on
// `/` and collapsed left-to-right on a stack: `.` and empty segments are
// skipped and `..` pops the preceding segment. A segment of only `*` wildcards
// is pushed as a non-name pin (it occupies a slot but cannot anchor the walk);
// the first surviving name-bearing segment is the pin. A prefix whose collapse
// runs the stack empty (the pattern reaches the root, e.g. `a/../**`) or where
// a `..` pops above the root (`src/../../**` escapes the workspace) leaves no
// literal pin, so the recursion is a whole-tree walk. A leading separator or
// dot-relative step (`/`, `./src/**`) likewise never pins to a real boundary.
function hasLiteralBefore(prefix: string): boolean {
  const segments = prefix.split("/");
  // A leading separator, dot, or dotdot step is root-relative notation that
  // does not pin to a concrete boundary, even when a name follows (`./src/**`
  // still walks from the root). `*/src/**` is unaffected: `*` is not a `..`.
  if (segments[0] === "" || segments[0] === "." || segments[0] === "..") {
    return false;
  }
  // Stack of surviving segments (true = name-bearing pin). `.`/empty are
  // skipped; `..` pops the top; all-wildcard runs push a non-name slot.
  const stack: boolean[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return false; // pop above the workspace root
      stack.pop();
      continue;
    }
    let isName = false;
    for (const char of segment) {
      if (char !== "*") {
        isName = true;
        break;
      }
    }
    stack.push(isName);
  }
  return stack.some(Boolean); // at least one name-bearing pin survives
}

// The raw path argument resolved against the session root: omitted, empty,
// ".", and the root itself all land on the workspace root. Non-filesystem
// targets (archive:///, tool-output:///) resolve elsewhere and never match.
export function isWorkspaceRootSearch(
  path: string | undefined,
  cwd: string,
): boolean {
  const candidate = path !== undefined && path.length > 0 ? path : ".";
  return resolvePath(cwd, candidate) === resolvePath(cwd);
}

export function isUnboundedRootSearch(args: {
  path: string | undefined;
  pattern: string;
  cwd: string;
}): boolean {
  return (
    isWorkspaceRootSearch(args.path, args.cwd) &&
    isUnboundedSearchGlob(args.pattern)
  );
}

export function formatUnboundedSearchMessage(
  tool: ScopedSearchTool,
  pattern: string,
): string {
  return (
    `${tool} refused an unbounded workspace-root walk for pattern "${pattern}" — ` +
    `${scopedSearchRetryHints(tool)}. ` +
    `This is not the same as "no matches".`
  );
}

export function formatToolExecutionTimeoutMessage(
  toolName: string,
  timeoutMs: number,
  partialResult?: string,
): string {
  const notice =
    `${toolName} ${TIMEOUT_PREFIX} after ${timeoutMs}ms — the tool run was stopped. ` +
    `Retry with a narrower scope, a smaller read, or a shorter shell command. ` +
    `This is not a normal error returned by the tool itself.`;
  const trimmed = partialResult?.trim();
  if (trimmed === undefined || trimmed.length === 0) return notice;
  return `${trimmed}\n\n${notice}`;
}

export function formatMcpToolTimeoutMessage(
  toolName: string,
  timeoutMs: number,
): string {
  const seconds = Math.round(timeoutMs / 1000);
  return (
    `MCP tool ${toolName} timed out after ${seconds}s — the server may be wedged; ` +
    `retry or continue without it.`
  );
}

export function formatReadFileTimeoutMessage(
  path: string,
  partialResult?: string,
): string {
  const notice =
    `read_file ${TIMEOUT_PREFIX} for ${path} — use a smaller offset/limit, ` +
    `grep to locate content first, or read a narrower path. ` +
    `This is not an empty file.`;
  const trimmed = partialResult?.trim();
  if (trimmed === undefined || trimmed.length === 0) return notice;
  return `${trimmed}\n\n${notice}`;
}
