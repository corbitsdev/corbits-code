import path from "node:path";

/** MIME written with spilled tool-output blobs. */
export type ToolResultContentType =
  | "application/json"
  | "application/x-ndjson"
  | "text/plain";

export interface MaterializedToolResult {
  text: string;
  contentType: ToolResultContentType;
}

// Pretty-printing a multi-megabyte blob is not worth the CPU/memory; leave it raw.
const PRETTY_SIZE_CEILING_CHARS = 8 * 1024 * 1024;

// Mirror vendor/intx-storage-isogit + optimized-context-store blob filenames so the
// absolute path named in the truncation notice matches what writeBlob actually wrote.
const TOOL_OUTPUT_DIR = "tool-output";
const UNSAFE_FILENAME_CHARS = /[^a-zA-Z0-9_-]/g;
const BLOB_EXTENSIONS: Readonly<Record<string, string>> = {
  "text/plain": ".txt",
  "application/json": ".json",
};

function blobExtensionFor(contentType: string): string {
  return BLOB_EXTENSIONS[contentType] ?? "";
}

function sanitizeCallId(callId: string): string {
  if (callId.includes("..") || callId.includes("/")) {
    throw new Error(`callId contains unsafe characters: ${JSON.stringify(callId)}`);
  }
  return callId.replace(UNSAFE_FILENAME_CHARS, "_");
}

/**
 * Absolute filesystem path the session store will use for a spilled blob key.
 * Must stay in lockstep with ContextStore.writeBlob's on-disk naming.
 */
export function toolOutputAbsolutePath(
  contextDir: string,
  key: string,
  contentType: string,
): string {
  const filename = `${sanitizeCallId(key)}${blobExtensionFor(contentType)}`;
  return path.join(contextDir, TOOL_OUTPUT_DIR, filename);
}

function looksLikeJsonDocument(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function isNdjson(text: string): boolean {
  // Require at least two non-empty lines that each parse as JSON. A single JSON
  // object on one line is handled by the document path instead. Strip a trailing
  // CR so CRLF-delimited NDJSON still classifies (JSON.parse rejects `"…}\r"`).
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length < 2) return false;
  for (const line of lines) {
    const candidate = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (candidate.length === 0) return false;
    try {
      JSON.parse(candidate);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Choose a durable representation for a tool result before it is spilled:
 * minified JSON → pretty application/json; multi-line NDJSON → keep as-is;
 * everything else → text/plain. Skips pretty-print above ~8MB.
 */
export function materializeToolResultContent(content: string): MaterializedToolResult {
  if (content.length > PRETTY_SIZE_CEILING_CHARS) {
    return { text: content, contentType: "text/plain" };
  }

  if (looksLikeJsonDocument(content)) {
    try {
      const parsed: unknown = JSON.parse(content);
      return {
        text: JSON.stringify(parsed, null, 2),
        contentType: "application/json",
      };
    } catch {
      // Not valid JSON — fall through to NDJSON / raw.
    }
  }

  if (isNdjson(content)) {
    return { text: content, contentType: "application/x-ndjson" };
  }

  return { text: content, contentType: "text/plain" };
}

/** Pretty-serialize a structured ToolResult Record for spill/truncation. */
export function materializeToolResultRecord(
  content: Record<string, unknown>,
): MaterializedToolResult {
  return {
    text: JSON.stringify(content, null, 2),
    contentType: "application/json",
  };
}
