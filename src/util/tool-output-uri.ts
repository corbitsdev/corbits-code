export const TOOL_OUTPUT_URI_PREFIX = "tool-output:";

export function isToolOutputLike(path: string): boolean {
  return path.startsWith(TOOL_OUTPUT_URI_PREFIX);
}

/** Accept common model mistakes (tool-output:/id) and normalize to tool-output:///id. */
export function normalizeToolOutputUri(path: string): string {
  if (!path.startsWith(TOOL_OUTPUT_URI_PREFIX)) return path;
  if (path.startsWith("tool-output:///")) return path;
  const rest = path.slice(TOOL_OUTPUT_URI_PREFIX.length).replace(/^\/+/, "");
  const callId = rest.split(/[/?#]/)[0] ?? "";
  if (callId.length === 0) return path;
  return `tool-output:///${callId}`;
}

/** Normalized tool-output URI with a non-empty callId, or undefined when not applicable. */
export function canonicalToolOutputUri(path: string): string | undefined {
  // No isToolOutputLike gate here: a non-like path normalizes to itself and
  // fails the prefix check below, so the outer guard would be redundant.
  const normalized = normalizeToolOutputUri(path);
  if (!normalized.startsWith("tool-output:///")) return undefined;
  const callId = normalized.slice("tool-output:///".length);
  if (callId.length === 0) return undefined;
  return normalized;
}

// Self-describing read_file continuation handles (CL-8980). A truncated read
// mints `tool-output:///cursor/<base64url>` instead of an opaque UUID: the
// handle itself carries the resume recipe (source + next offset + window
// limit + nonce), so following it needs no in-memory record and keeps working
// across session resume, prune, and compaction. The nonce keeps every mint a
// distinct one-shot even for identical windows, preserving spent-handle
// replay semantics.
export const CURSOR_HANDLE_PREFIX = "tool-output:///cursor/";

export type ResumeSource =
  | { kind: "file"; path: string }
  | { kind: "blob"; uri: string };

export interface ResumeCursor {
  source: ResumeSource;
  offset: number;
  limit: number;
  nonce: string;
}

const CURSOR_CODEC_VERSION = 1;

export function encodeResumeCursor(cursor: ResumeCursor): string {
  const payload = JSON.stringify({
    v: CURSOR_CODEC_VERSION,
    source: cursor.source,
    offset: cursor.offset,
    limit: cursor.limit,
    nonce: cursor.nonce,
  });
  return `${CURSOR_HANDLE_PREFIX}${Buffer.from(payload, "utf8").toString("base64url")}`;
}

/** Decode a self-describing handle. Never throws: anything malformed (or any
 * older opaque handle / never-a-handle URI) decodes to undefined. */
export function decodeResumeCursor(
  canonical: string | undefined,
): ResumeCursor | undefined {
  try {
    if (canonical === undefined) return undefined;
    if (!canonical.startsWith(CURSOR_HANDLE_PREFIX)) return undefined;
    const payload = JSON.parse(
      Buffer.from(
        canonical.slice(CURSOR_HANDLE_PREFIX.length),
        "base64url",
      ).toString("utf8"),
    ) as {
      v?: unknown;
      source?: unknown;
      offset?: unknown;
      limit?: unknown;
      nonce?: unknown;
    };
    if (payload.v !== CURSOR_CODEC_VERSION) return undefined;
    const { source, offset, limit, nonce } = payload;
    if (
      typeof offset !== "number" ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit <= 0 ||
      typeof nonce !== "string" ||
      nonce.length === 0
    ) {
      return undefined;
    }
    if (typeof source !== "object" || source === null || !("kind" in source)) {
      return undefined;
    }
    if (
      source.kind === "file" &&
      "path" in source &&
      typeof source.path === "string" &&
      source.path.length > 0
    ) {
      return {
        source: { kind: "file", path: source.path },
        offset,
        limit,
        nonce,
      };
    }
    if (
      source.kind === "blob" &&
      "uri" in source &&
      typeof source.uri === "string" &&
      source.uri.startsWith("tool-output:///")
    ) {
      return {
        source: { kind: "blob", uri: source.uri },
        offset,
        limit,
        nonce,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}
