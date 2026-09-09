export const ARCHIVE_URI_PREFIX = "archive:";
const ARCHIVE_URI_CANONICAL = "archive:///";

export function formatArchiveRef(occurrenceId: string): string {
  return `${ARCHIVE_URI_CANONICAL}${occurrenceId}`;
}

/** Accept archive:///occ-… and common slashes; return the occurrence id or undefined. */
export function parseArchiveRef(value: string): string | undefined {
  if (!value.startsWith(ARCHIVE_URI_PREFIX)) return undefined;
  const rest = value.slice(ARCHIVE_URI_PREFIX.length).replace(/^\/+/, "");
  const occurrenceId = rest.split(/[/?#]/)[0] ?? "";
  if (occurrenceId.length === 0) return undefined;
  return occurrenceId;
}
