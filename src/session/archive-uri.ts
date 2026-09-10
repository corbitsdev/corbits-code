export const ARCHIVE_URI_PREFIX = "archive:";
const ARCHIVE_URI_CANONICAL = "archive:///";

export function formatArchiveRef(occurrenceId: string): string {
  return `${ARCHIVE_URI_CANONICAL}${occurrenceId}`;
}

export function isArchiveLike(path: string): boolean {
  return path.startsWith(ARCHIVE_URI_PREFIX);
}

/** Accept archive:///occ-… and common slashes; return the occurrence id or undefined. */
export function parseArchiveRef(value: string): string | undefined {
  return parseArchiveTarget(value)?.occurrenceId;
}

/** Root `archive:///` has no occurrenceId; a ref includes one. */
export function parseArchiveTarget(
  value: string,
): { occurrenceId?: string } | undefined {
  if (!isArchiveLike(value)) return undefined;
  const rest = value.slice(ARCHIVE_URI_PREFIX.length).replace(/^\/+/, "");
  const occurrenceId = rest.split(/[/?#]/)[0] ?? "";
  if (occurrenceId.length === 0) return {};
  return { occurrenceId };
}
