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

export const THINKING_ONLY_OMITTED = "[thinking-only turn omitted]";

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

function hasTextOrToolCall(content: ContentBlock[]): boolean {
  return content.some((block) => block.type === "text" || block.type === "tool_call");
}

// transformMessages drops an assistant turn only when stripping thinking
// leaves empty content. Same-model thinking-only and leftover-only turns
// survive with no text/tool_call; adapters then 400 or used to drop them,
// producing an identical next request and a thinking-only loop. Replace
// the unusable turn with a stable text marker so the turn stays, roles
// alternate, and the wire body changes.
function replaceUnusableAssistantTurn(turn: ConversationTurn): ConversationTurn {
  if (turn.role !== "assistant" || hasTextOrToolCall(turn.content)) return turn;
  return { ...turn, content: [{ type: "text", text: THINKING_ONLY_OMITTED }] };
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
  // A turn with no `model` recorded (an optional field on the persisted
  // schema) is not evidence it came from a foreign provider. Both this
  // module's own foreign-turn gate below AND the vendored transformMessages'
  // same-model check key off exact `model` equality — transformMessages is
  // not ours to change, so a model-less turn is stamped with the target
  // model before either stage runs. That reads as "this model", not
  // "foreign", to both stages; without it transformMessages strips the
  // turn's thinking blocks outright regardless of what this module decides.
  const modelFilled = turns.map((turn) =>
    turn.role === "assistant" && turn.model === undefined ? { ...turn, model: targetModel } : turn,
  );
  const stripped = modelFilled.map((turn) =>
    turn.role === "assistant" && turn.model !== targetModel ? stripForeignBlocks(turn) : turn,
  );
  const marked = stripped.map(replaceUnusableAssistantTurn);
  return transformMessages(marked, { targetModel });
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
