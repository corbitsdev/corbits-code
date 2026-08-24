import type { ToolPlugin } from "@intx/tools-posix";

const TRUNCATABLE_TOOLS = new Set(["read_file", "grep", "run_shell", "search_files", "web_fetch"]);

// Characters, not tokens — conversion ratio is roughly 4 chars/token.
// 80 000 chars ≈ 20 000 tokens. Keeps a single result from dominating context.
export const MAX_RESULT_CHARS = 80_000;

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
}

/**
 * Blob key the full pre-cut content is written under. Deliberately NOT the
 * bare callId: the reactor's own size-cap transform (vendor/intx-inference's
 * assembly.ts, always on, default cap 10,000 chars) runs on every ToolResult
 * after this middleware returns it, and — because our inline "kept" text can
 * itself exceed that cap — spills its own (already-truncated-by-us) copy to
 * `contextStore.writeBlob(call.id, ...)`. Writing our full spill under the
 * same key would let that second write silently clobber it with a lossier
 * copy (confirmed by reproducing the two writes back to back in
 * result-truncation-plugin.test.ts). The ":full" suffix keeps our blob a
 * distinct entry the reactor never touches.
 */
export function spillBlobKey(callId: string): string {
  return `${callId}:full`;
}

// The single primitive for size truncation: callers may pass their own
// threshold but never invent their own wording, so a result can never carry
// two differently-worded "truncated" notices. Called directly by runners this
// middleware does not wrap — the MCP tool runner (src/mcp/plugin.ts). The
// posix chain gets this middleware prepended unconditionally in
// posix-tool-plugins.ts, so plugins like ripgrepPlugin that answer without
// calling next() no longer need to apply the cap themselves.
//
// When `spill` is supplied, the FULL (pre-cut) content is written to the
// session's own blob store — the same `ContextStore.writeBlob` /
// `tool-output:///{key}` machinery the reactor's own size-cap transform uses
// — and the notice names that real URI. Writing into the blob store (rather
// than a side file) means the content is staged and committed with the rest
// of the turn (see createOptimizedContextStore), so it persists exactly as
// long as the session's own history does: forever, by design, same as every
// other spilled tool output. No separate cleanup exists or is needed.
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

  const remaining = content.length - maxChars;
  const kept = content.slice(0, maxChars);

  if (spill === undefined) {
    return (
      kept +
      `\n[output truncated at ${maxChars.toLocaleString()} chars — ` +
      `${remaining.toLocaleString()} chars discarded, NOT retrievable ` +
      `(no blob store is configured; re-running gives the same cut). ` +
      `Use offset/limit or a narrower query.]`
    );
  }

  const key = spillBlobKey(spill.callId);
  const uri = `tool-output:///${key}`;
  await spill.writeBlob(key, new TextEncoder().encode(content), "text/plain");
  return (
    kept +
    `\n[output truncated at ${maxChars.toLocaleString()} chars — ` +
    `${remaining.toLocaleString()} more chars omitted here. The full result ` +
    `(${content.length.toLocaleString()} chars) is saved at ${uri} — ` +
    `use read_file with that URI (offset/limit supported) to see the rest.]`
  );
}

export interface ResultTruncationPluginOptions {
  // Live getter for the session's blob writer, re-read on every call so a
  // session rotation (new sessionId mid-process) spills into the new
  // session's store rather than a stale one. Omitted only where there is no
  // session store to spill into (tests, ad-hoc toolsets) — truncation still
  // runs, just without a retrievable remainder.
  getBlobWriter?: () => SpillBlobWriter | undefined;
}

export function resultTruncationPlugin(options: ResultTruncationPluginOptions = {}): ToolPlugin {
  const { getBlobWriter } = options;
  return {
    middleware: (next) => async (call, signal) => {
      const result = await next(call, signal);
      if (!TRUNCATABLE_TOOLS.has(call.name) || result.isError) return result;

      const { content } = result;
      if (typeof content !== "string") return result;
      const writeBlob = getBlobWriter?.();
      const spill = writeBlob !== undefined ? { callId: call.id, writeBlob } : undefined;
      const truncated = await truncateToolResultContent(content, MAX_RESULT_CHARS, spill);
      if (truncated === content) return result;
      return { ...result, content: truncated };
    },
  };
}
