import { transformMessages, type AdapterRegistry } from "@intx/inference";
import type { ContentBlock, ConversationTurn } from "@intx/types/runtime";

// Repairs persisted history at the request-build boundary so a turn produced
// by one provider replays safely against another. transformMessages (vendored)
// strips thinking blocks for foreign-model turns, rewrites safety_rating to
// text, and answers dangling tool_calls with synthetic error results — the
// same tool_result/isError shape the reactor's gate-timeout path appends.
// What it does not cover, this module handles first: output-only block types
// with no cross-provider wire shape (refusal, citation, redacted_thinking,
// audio, video, code execution) that make adapter builders throw, and opaque
// provider signatures that a foreign provider rejects when echoed back.

// Output-only shapes a foreign provider cannot round-trip; adapter builders
// throw on them, so they are dropped from foreign-model turns before build.
const FOREIGN_UNMAPPABLE_TYPES = new Set<ContentBlock["type"]>([
  "redacted_thinking",
  "citation",
  "audio",
  "video",
  "code_execution_request",
  "code_execution_result",
]);

function stripForeignBlocks(turn: ConversationTurn): ConversationTurn {
  const content = turn.content.flatMap((block): ContentBlock[] => {
    if (block.type === "refusal") {
      return [{ type: "text", text: block.reason }];
    }
    if (FOREIGN_UNMAPPABLE_TYPES.has(block.type)) {
      return [];
    }
    // Signatures authenticate a block to the provider that signed it; a
    // foreign provider 400s when one is echoed back (Gemini replays them
    // as thoughtSignature verbatim).
    if ("signature" in block && block.signature !== undefined) {
      const unsigned = { ...block };
      delete unsigned.signature;
      return [unsigned];
    }
    return [block];
  });
  return { ...turn, content };
}

/**
 * Repair persisted turns for replay against `targetModel`. Assistant turns
 * produced by a different model lose blocks the target provider cannot
 * accept; dangling tool_calls are answered with synthetic error results.
 */
export function sanitizeReplayTurns(
  turns: ConversationTurn[],
  targetModel: string,
): ConversationTurn[] {
  const repaired = turns.map((turn) =>
    turn.role === "assistant" && turn.model !== targetModel ? stripForeignBlocks(turn) : turn,
  );
  return transformMessages(repaired, { targetModel });
}

/**
 * Wrap an adapter registry so every resolved adapter sanitizes replayed
 * turns before building its request.
 */
export function withReplaySanitizer(adapters: AdapterRegistry): AdapterRegistry {
  return {
    has: (provider) => adapters.has(provider),
    resolve(source, quirks) {
      const adapter = adapters.resolve(source, quirks);
      return {
        ...adapter,
        buildRequest: (turns, model, options) =>
          adapter.buildRequest(sanitizeReplayTurns(turns, model), model, options),
      };
    },
  };
}
