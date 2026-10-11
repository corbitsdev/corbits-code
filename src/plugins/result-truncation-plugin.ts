import type { AgentTool } from "@intx/agent";
import type { ToolPlugin } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import {
  materializeToolResultContent,
  materializeToolResultRecord,
  toolOutputAbsolutePath,
  type MaterializedToolResult,
} from "./tool-result-materialize.js";
import { scrubSecretShapedContent } from "./tool-result-secret-scrub.js";
import {
  hashAuthorizedBytes,
  type CompactionArchive,
} from "../session/compaction-archive.js";

// Characters, not tokens (~4 chars/token). Matches the reactor's size-cap so
// this middleware spills the full bytes before the reactor's 10k transform
// writes a lossier copy under the bare call id.
export const MAX_RESULT_CHARS = 10_000;

/**
 * Writes a blob to the session's context store (ContextStore.writeBlob shape).
 */
export type SpillBlobWriter = (
  key: string,
  bytes: Uint8Array,
  contentType: string,
) => Promise<void>;

/** Session blob-store handle a truncation can spill its full content into. */
export interface TruncationSpillOptions {
  callId: string;
  writeBlob: SpillBlobWriter;
  /**
   * Absolute session context dir; the notice then names the on-disk spill
   * path.
   */
  contextDir?: string;
}

/**
 * Blob key for the full pre-cut content. Deliberately not the bare callId:
 * the reactor's always-on 10k size-cap could spill an over-cap result under
 * that id and clobber this write. The ":full" suffix keeps the entry distinct.
 */
export function spillBlobKey(callId: string): string {
  return `${callId}:full`;
}

export function truncationNotice(args: {
  maxChars: number;
  remaining: number;
  fullLength: number;
  contentType: string;
  uri?: string;
  absolutePath?: string;
}): string {
  const { maxChars, remaining, fullLength, contentType, uri, absolutePath } =
    args;
  if (uri === undefined) {
    return (
      `\n[output truncated at ${maxChars.toLocaleString()} chars — ` +
      `${remaining.toLocaleString()} chars discarded, NOT retrievable ` +
      `(no blob store is configured; re-running gives the same cut). ` +
      `Use offset/limit or a narrower query.]`
    );
  }
  const pathBit =
    absolutePath !== undefined ? ` (session path: ${absolutePath})` : "";
  return (
    `\n[output truncated at ${maxChars.toLocaleString()} chars — ` +
    `${remaining.toLocaleString()} more chars omitted here. The full result ` +
    `(${fullLength.toLocaleString()} chars, ${contentType}) is saved at ${uri}` +
    `${pathBit} — use read_file with that URI (offset/limit supported) to see the rest.]`
  );
}

/**
 * Keeps kept + notice within maxChars by reserving the notice before slicing.
 * Appending after would exceed the cap and let the reactor's size-cap replace
 * the string, stripping the spill URI the model needs.
 */
export function truncateWithReservedNotice(
  text: string,
  maxChars: number,
  buildNotice: (keptLen: number) => string,
): string {
  let keptLen = maxChars;
  for (let i = 0; i < 8; i++) {
    const notice = buildNotice(keptLen);
    const total = keptLen + notice.length;
    if (total <= maxChars) return text.slice(0, keptLen) + notice;
    keptLen -= total - maxChars;
    if (keptLen < 0) keptLen = 0;
  }

  const notice = buildNotice(keptLen);
  return (text.slice(0, keptLen) + notice).slice(0, maxChars);
}

async function spillAndTruncate(
  materialized: MaterializedToolResult,
  maxChars: number,
  spill?: TruncationSpillOptions,
): Promise<string> {
  const { contentType } = materialized;
  const text = scrubSecretShapedContent(materialized.text);
  if (text.length <= maxChars) return text;

  if (spill === undefined) {
    return truncateWithReservedNotice(text, maxChars, (keptLen) =>
      truncationNotice({
        maxChars,
        remaining: text.length - keptLen,
        fullLength: text.length,
        contentType,
      }),
    );
  }

  const key = spillBlobKey(spill.callId);
  const uri = `tool-output:///${key}`;
  await spill.writeBlob(key, new TextEncoder().encode(text), contentType);
  const absolutePath =
    spill.contextDir !== undefined
      ? toolOutputAbsolutePath(spill.contextDir, key, contentType)
      : undefined;
  return truncateWithReservedNotice(text, maxChars, (keptLen) =>
    truncationNotice({
      maxChars,
      remaining: text.length - keptLen,
      fullLength: text.length,
      contentType,
      uri,
      ...(absolutePath !== undefined ? { absolutePath } : {}),
    }),
  );
}

// Single truncation primitive: callers pass their own threshold but never
// their own wording, so a result never carries two different truncation
// notices. Runs directly in runners the middleware does not wrap (MCP:
// src/mcp/plugin.ts) and is prepended to the posix chain in
// posix-tool-plugins.ts, so plugins that answer without calling next() still
// get the cap.
//
// Over-gate content is leisure-materialized first (pretty JSON / preserved
// NDJSON / raw text); the formatted bytes are what we spill and truncate.
// Under-gate content passes through unchanged.
//
// With `spill`, the full formatted content goes to the session blob store
// and the notice names that URI (plus the absolute path when `contextDir`
// is set). Staged with the turn, the blob lives as long as the session
// history does. Without `spill` (tests, no session store), the notice says
// the rest is gone and never claims a retrieval path that does not exist.
export async function truncateToolResultContent(
  content: string,
  maxChars: number = MAX_RESULT_CHARS,
  spill?: TruncationSpillOptions,
): Promise<string> {
  if (content.length <= maxChars) return content;
  return spillAndTruncate(
    materializeToolResultContent(content),
    maxChars,
    spill,
  );
}

/**
 * Same gate/spill path as {@link truncateToolResultContent} for Record
 * content: pretty-serialize, then spill/truncate when over the gate.
 */
export async function truncateToolResultRecord(
  content: Record<string, unknown>,
  maxChars: number = MAX_RESULT_CHARS,
  spill?: TruncationSpillOptions,
): Promise<string> {
  const compactLength = JSON.stringify(content).length;
  if (compactLength <= maxChars) {
    // Under-gate records serialize pretty so string callers get a stable shape.
    return materializeToolResultRecord(content).text;
  }
  return spillAndTruncate(
    materializeToolResultRecord(content),
    maxChars,
    spill,
  );
}

export interface ResultTruncationPluginOptions {
  // Live getters, re-read per call so a session rotation spills into the new
  // session's store. Omitted where there is no session store (tests, ad-hoc
  // toolsets): truncation still runs, without a retrievable remainder.
  getBlobWriter?: () => SpillBlobWriter | undefined;
  // Absolute session context dir for the notice's on-disk path; re-read like
  // getBlobWriter.
  getContextDir?: () => string | undefined;
  /** Primary-only evidence archive; workers omit this getter. */
  getEvidenceArchive?: () => CompactionArchive | undefined;
}

async function archiveAuthorizedResult(
  archive: CompactionArchive | undefined,
  callId: string,
  content: string | Record<string, unknown>,
  isError: boolean | undefined,
): Promise<void> {
  if (archive === undefined) return;
  await archive.recordAuthorizedPayload({
    kind: "tool_result",
    payload: content,
    callId,
    provenance:
      isError === true ? "posix:error" : "posix:post-policy-pre-truncation",
  });
}

function spillOptionsForCall(
  callId: string,
  options: ResultTruncationPluginOptions,
): TruncationSpillOptions | undefined {
  const writeBlob = options.getBlobWriter?.();
  const contextDir = options.getContextDir?.();
  return writeBlob !== undefined
    ? {
        callId,
        writeBlob,
        ...(contextDir !== undefined ? { contextDir } : {}),
      }
    : undefined;
}

/**
 * Materialize and spill a tool result when its compact payload exceeds
 * {@link MAX_RESULT_CHARS}. Errors pass through. Shared by the posix
 * middleware and the AgentTool wrapper so fleet verbs take the same path.
 */
export async function applyToolResultTruncation(
  result: ToolResult,
  spill?: TruncationSpillOptions,
): Promise<ToolResult> {
  if (result.isError) return result;

  const { content } = result;
  if (typeof content === "string") {
    const truncated = await truncateToolResultContent(
      content,
      MAX_RESULT_CHARS,
      spill,
    );
    if (truncated === content) return result;
    return { ...result, content: truncated };
  }

  if (content !== null && typeof content === "object") {
    const record = content as Record<string, unknown>;
    const compact = JSON.stringify(record);
    if (compact.length <= MAX_RESULT_CHARS) return result;
    const truncated = await truncateToolResultRecord(
      record,
      MAX_RESULT_CHARS,
      spill,
    );
    return { ...result, content: truncated };
  }

  return result;
}

// read_file pages carry their own `Use offset=` continuation footer. Re-cutting
// at the 10k cap would slice the footer off and strand pagination, so
// footer-bearing pages pass through intact.
const READ_FILE_CONTINUATION_RE = /Use offset=\d+ to continue\./;

function isPagedReadFilePage(
  toolName: string | undefined,
  result: ToolResult,
): boolean {
  return (
    toolName === "read_file" &&
    typeof result.content === "string" &&
    READ_FILE_CONTINUATION_RE.test(result.content)
  );
}

async function archiveThenTruncate(
  result: ToolResult,
  callId: string,
  options: ResultTruncationPluginOptions,
  toolName?: string,
): Promise<ToolResult> {
  const archive = options.getEvidenceArchive?.();
  try {
    if (typeof result.content === "string") {
      await archiveAuthorizedResult(
        archive,
        callId,
        result.content,
        result.isError,
      );
    } else if (result.content !== null && typeof result.content === "object") {
      await archiveAuthorizedResult(
        archive,
        callId,
        result.content as Record<string, unknown>,
        result.isError,
      );
    }
  } catch {
    // Archive write must not fail a successful tool result.
  }

  const before = result.content;
  if (isPagedReadFilePage(toolName, result)) return result;
  const truncated = await applyToolResultTruncation(
    result,
    spillOptionsForCall(callId, options),
  );
  if (
    archive !== undefined &&
    typeof before === "string" &&
    typeof truncated.content === "string" &&
    truncated.content !== before &&
    before.length > MAX_RESULT_CHARS
  ) {
    try {
      const spilled =
        typeof before === "string"
          ? scrubSecretShapedContent(materializeToolResultContent(before).text)
          : scrubSecretShapedContent(
              materializeToolResultRecord(before as Record<string, unknown>)
                .text,
            );
      await archive.recordExistingBlobReference({
        kind: "overflow_blob",
        blobKey: spillBlobKey(callId),
        contentHash: hashAuthorizedBytes(new TextEncoder().encode(spilled)),
        callId,
        provenance: "result-truncation:full",
      });
    } catch {
      // Archive write must not fail a successful tool result.
    }
  }
  return truncated;
}

/**
 * Wrap an AgentTool so its result hits {@link applyToolResultTruncation}.
 * `kind: "string"` handlers lift to `kind: "full"` so the spill can use the
 * call id; factories such as createSearchAgentsTool stay `"string"` until
 * mount.
 */
export function wrapAgentToolResultTruncation(
  tool: AgentTool,
  options: ResultTruncationPluginOptions = {},
): AgentTool {
  if (tool.kind === "full") {
    const inner = tool.handler;
    return {
      ...tool,
      handler: async (call: ToolCall, signal: AbortSignal) =>
        archiveThenTruncate(
          await inner(call, signal),
          call.id,
          options,
          tool.definition.name,
        ),
    };
  }
  const inner = tool.handler;
  return {
    kind: "full",
    definition: tool.definition,
    handler: async (call: ToolCall, signal: AbortSignal) =>
      archiveThenTruncate(
        { callId: call.id, content: await inner(call.arguments, signal) },
        call.id,
        options,
        tool.definition.name,
      ),
  };
}

export function wrapAgentToolsWithResultTruncation(
  tools: readonly AgentTool[],
  options: ResultTruncationPluginOptions = {},
): AgentTool[] {
  return tools.map((tool) => wrapAgentToolResultTruncation(tool, options));
}

export function resultTruncationPlugin(
  options: ResultTruncationPluginOptions = {},
): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      const result = await next(call, signal);
      return archiveThenTruncate(result, call.id, options, call.name);
    },
  };
}
