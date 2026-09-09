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
import { hashAuthorizedBytes, type CompactionArchive } from "../session/compaction-archive.js";

// Characters, not tokens — conversion ratio is roughly 4 chars/token.
// Match the reactor's default size-cap (vendor/intx-inference assembly.ts) so
// leisure materialization owns the spill of the pretty/full bytes under the
// `:full` key before the reactor's own 10k transform can write a lossier copy
// under the bare call id.
export const MAX_RESULT_CHARS = 10_000;

/** Writes a blob to the session's context store (ContextStore.writeBlob's shape). */
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
   * Absolute path to the session context dir (`…/context`). When set, the
   * truncation notice also names the on-disk tool-output path beside the
   * `tool-output:///` URI so an operator can open the spill directly.
   */
  contextDir?: string;
}

/**
 * Blob key the full pre-cut content is written under. Deliberately NOT the
 * bare callId: the reactor's own size-cap transform (vendor/intx-inference's
 * assembly.ts, always on, default cap 10,000 chars) runs on every ToolResult
 * after this middleware returns it. Leisure truncation keeps the inline
 * result (kept + notice) ≤ maxChars so that transform normally passes through
 * within-cap, but any other path that still exceeds the cap would spill under
 * the bare call id and clobber a same-keyed full write. The ":full" suffix
 * keeps our blob a distinct entry the reactor never touches.
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
 * Truncates so the FINAL result (kept + notice) never exceeds maxChars — the
 * notice is reserved before slicing, not appended after. Without this, leisure
 * output is maxChars+noticeLen and the reactor's always-on 10k size-cap
 * (createSizeCapTransform) replaces the whole string, stripping the leisure
 * URI+path the model needs. Notice length depends on digit counts of
 * remaining/fullLength (and optional absolutePath), so shrink kept until the
 * assembled result fits.
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

// The single primitive for size truncation: callers may pass their own
// threshold but never invent their own wording, so a result can never carry
// two differently-worded "truncated" notices. Called directly by runners this
// middleware does not wrap — the MCP tool runner (src/mcp/plugin.ts). The
// posix chain gets this middleware prepended unconditionally in
// posix-tool-plugins.ts, so plugins like ripgrepPlugin that answer without
// calling next() no longer need to apply the cap themselves.
//
// When content exceeds `maxChars`, it is leisure-materialized first (pretty
// JSON / preserved NDJSON / raw text) and the FORMATTED bytes are what we
// spill and what we truncate inline. Under-gate content is returned unchanged
// (no pretty, no blob).
//
// When `spill` is supplied, the full formatted content is written to the
// session's own blob store — the same `ContextStore.writeBlob` /
// `tool-output:///{key}` machinery the reactor's own size-cap transform uses
// — and the notice names that real URI (plus the absolute session path when
// `contextDir` is plumbed). Writing into the blob store (rather than a side
// file) means the content is staged and committed with the rest of the turn
// (see createOptimizedContextStore), so it persists exactly as long as the
// session's own history does: forever, by design, same as every other spilled
// tool output. No separate cleanup exists or is needed.
//
// Without `spill` (tests, or a caller with no session store to write into)
// the notice says plainly that the rest is gone; it must never claim a
// retrieval path that does not exist (CL-6908).
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
 * Same gate/spill path as {@link truncateToolResultContent} for structured
 * `ToolResult.content` Records: pretty-serialize, then spill/truncate the
 * formatted JSON when over the gate.
 */
export async function truncateToolResultRecord(
  content: Record<string, unknown>,
  maxChars: number = MAX_RESULT_CHARS,
  spill?: TruncationSpillOptions,
): Promise<string> {
  const compactLength = JSON.stringify(content).length;
  if (compactLength <= maxChars) {
    // Under-gate Records stay Records at the plugin layer; this helper is only
    // reached when the plugin has already decided to serialize. Return pretty
    // so callers that asked for a string get a stable shape.
    return materializeToolResultRecord(content).text;
  }
  return spillAndTruncate(
    materializeToolResultRecord(content),
    maxChars,
    spill,
  );
}

export interface ResultTruncationPluginOptions {
  // Live getter for the session's blob writer, re-read on every call so a
  // session rotation (new sessionId mid-process) spills into the new
  // session's store rather than a stale one. Omitted only where there is no
  // session store to spill into (tests, ad-hoc toolsets) — truncation still
  // runs, just without a retrievable remainder.
  getBlobWriter?: () => SpillBlobWriter | undefined;
  // Live getter for the absolute session context dir, re-read like
  // getBlobWriter so rotation picks up the new path for the notice.
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
    provenance: isError === true ? "posix:error" : "posix:post-policy-pre-truncation",
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
 * Leisure-materialize and spill a tool result when its compact payload exceeds
 * {@link MAX_RESULT_CHARS}. Error results are returned unchanged. Shared by the
 * posix middleware and the AgentTool wrapper so fleet verbs (which never enter
 * the posix plugin chain) take the same path.
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

async function archiveThenTruncate(
  result: ToolResult,
  callId: string,
  options: ResultTruncationPluginOptions,
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
 * `kind: "string"` handlers are lifted to `kind: "full"` so the spill can use
 * the call id. Factories such as createSearchAgentsTool stay `kind: "string"`
 * until mount.
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
        archiveThenTruncate(await inner(call, signal), call.id, options),
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
      return archiveThenTruncate(result, call.id, options);
    },
  };
}