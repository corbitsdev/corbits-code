/** Intercode-local timeout copy for search/read guards. Do not patch interchange. */

export type ScopedSearchTool = "grep" | "search_files";

const TIMEOUT_PREFIX = "[timed out before completing]";

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