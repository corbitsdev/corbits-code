// Running local estimate of inference context size.
//
// Providers sometimes omit usage or report zero, which would otherwise leave
// the compaction governor blind. We count the turns we actually send (text,
// tool payloads, images) so proactive compaction still has a signal. This is
// a lower bound: system prompt, tool schemas, and framing are not counted.

import type { ContentBlock, ConversationTurn, MediaSource } from "@intx/types/runtime";

const CHARS_PER_TOKEN = 4;

// Media carried by URL or opaque file handle has no local bytes. A fixed floor
// keeps attached images from vanishing from the estimate entirely.
const MEDIA_REFERENCE_FLOOR_TOKENS = 1_000;

export function estimateTokensFromChars(chars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateMediaSourceTokens(source: MediaSource): number {
  if (source.kind === "base64") {
    return estimateTokensFromChars(source.data.length);
  }
  return MEDIA_REFERENCE_FLOOR_TOKENS;
}

export function estimateContentBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return estimateTokensFromChars(block.text.length);
    case "thinking":
      return estimateTokensFromChars(block.thinking.length);
    case "redacted_thinking":
      return estimateTokensFromChars(block.data.length);
    case "refusal":
      return estimateTokensFromChars(block.reason.length);
    case "tool_call":
      return estimateTokensFromChars(
        block.name.length + JSON.stringify(block.arguments).length,
      );
    case "tool_result":
      return block.content.reduce((sum, part) => sum + estimateContentBlockTokens(part), 0);
    case "image":
    case "audio":
    case "video":
    case "document":
      return estimateMediaSourceTokens(block.source);
    case "citation":
      return estimateTokensFromChars(
        block.citedText.length +
          (block.source.title?.length ?? 0) +
          (block.source.uri?.length ?? 0),
      );
    case "code_execution_request":
      return estimateTokensFromChars(block.code.length + (block.language?.length ?? 0));
    case "code_execution_result":
      return estimateTokensFromChars(
        (block.stdout?.length ?? 0) +
          (block.stderr?.length ?? 0) +
          (block.abortReason?.length ?? 0),
      );
  }
}

export function estimateContextTokens(turns: readonly ConversationTurn[]): number {
  let total = 0;
  for (const turn of turns ?? []) {
    for (const block of turn.content) {
      total += estimateContentBlockTokens(block);
    }
  }
  return total;
}

// Mutable running estimate. Callers re-sync from the full turn list after each
// append so compaction rewrites and tool results stay accurate without
// incremental add/subtract bookkeeping.
export type ContextEstimate = ReturnType<typeof createContextEstimate>;

export function createContextEstimate() {
  let tokens = 0;
  let turnCount = 0;

  function syncFromTurns(turns: readonly ConversationTurn[]): number {
    tokens = estimateContextTokens(turns);
    turnCount = turns.length;
    return tokens;
  }

  return {
    get tokens(): number {
      return tokens;
    },
    get turnCount(): number {
      return turnCount;
    },
    syncFromTurns,
  };
}
