// Running local estimate of inference context size.
//
// Providers sometimes omit usage or report zero, which would otherwise leave
// the compaction governor blind. We count the turns we actually send (text,
// tool payloads, images) so proactive compaction still has a signal. This is
// a lower bound: system prompt, tool schemas, and framing are not counted.

import type {
  ContentBlock,
  ConversationTurn,
  MediaSource,
  ToolDefinition,
} from "@intx/types/runtime";

const CHARS_PER_TOKEN = 4;

// Media carried by URL or opaque file handle has no local bytes. A fixed floor
// keeps attached images from vanishing from the estimate entirely.
const MEDIA_REFERENCE_FLOOR_TOKENS = 1_000;

// Providers bill vision tiles, not raw base64 length. Uncapped chars/4 turns a
// 1MB screenshot into ~250k tokens and thrash-arms compaction.
const MEDIA_BASE64_MAX_TOKENS = 2_500;

export function estimateTokensFromChars(chars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateMediaSourceTokens(source: MediaSource): number {
  if (source.kind === "base64") {
    return Math.min(estimateTokensFromChars(source.data.length), MEDIA_BASE64_MAX_TOKENS);
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

// The system prompt and tool schemas ride on every request the same way turns
// do, but they never appear in `turns` — they're framing the harness supplies
// out of band. Without this, the estimate undercounts by whatever AGENTS.md
// and the active tool roster cost, which is often tens of thousands of tokens
// before a single turn is sent.
export function estimateOverheadTokens(
  systemPrompt: string,
  toolDefinitions: readonly ToolDefinition[],
): number {
  let chars = systemPrompt.length;
  for (const tool of toolDefinitions) {
    chars += tool.name.length + tool.description.length + JSON.stringify(tool.inputSchema).length;
  }
  return estimateTokensFromChars(chars);
}

// Mutable running estimate. Callers re-sync from the full turn list after each
// append so compaction rewrites and tool results stay accurate without
// incremental add/subtract bookkeeping. `overheadTokens` is fixed per session
// (system prompt + tool schemas do not change turn to turn) and is folded into
// every sync so the total tracks what actually goes out on the wire.
export type ContextEstimate = ReturnType<typeof createContextEstimate>;

export function createContextEstimate(overheadTokens = 0) {
  let tokens = overheadTokens;
  let turnCount = 0;

  function syncFromTurns(turns: readonly ConversationTurn[]): number {
    tokens = overheadTokens + estimateContextTokens(turns);
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
