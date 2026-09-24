// Prompt-only shrink after an Anthropic ephemeral cache write expires.
// Compaction rewrites turns.jsonl and keeps a raw tail, so the next infer
// still cache-writes those tool bodies. This transform runs inside
// executeInfer: its output is what gets written to prompt.jsonl. It never
// writes turns and never calls the compaction governor.

import type {
  ContentBlock,
  ContextTransform,
  ConversationTurn,
} from "@intx/types/runtime";

import { cacheTtlMsFor } from "../provider/cache-ttl.js";

export type AnthropicCachePromptDeps = {
  nowMs: () => number;
  /** Wall time of the last Anthropic-protocol cache write, if one was stamped. */
  cacheWriteAt: () => number | undefined;
  /** Live adapter protocol (`InferenceSource.provider`). */
  protocol: () => string | undefined;
};

const STRATEGY = "anthropic-cache-prompt";

type ToolResultBlock = Extract<ContentBlock, { type: "tool_result" }>;

function passthrough(
  turns: ConversationTurn[],
  reason: string,
): Awaited<ReturnType<ContextTransform["apply"]>> {
  return {
    output: turns,
    record: {
      strategy: STRATEGY,
      version: "1",
      parameters: {},
      reason,
      decisions: { stubbed: 0 },
    },
  };
}

function newestAssistantTextIndex(turns: readonly ConversationTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn === undefined || turn.role !== "assistant") continue;
    if (
      turn.content.some(
        (block) => block.type === "text" && block.text.length > 0,
      )
    ) {
      return i;
    }
  }
  return -1;
}

// Tool results before the newest assistant text are already consumed.
// When the model has not written that text yet, the newest result turn is
// the unconsumed suffix and stays whole.
function stubBoundary(turns: readonly ConversationTurn[]): number {
  const assistantText = newestAssistantTextIndex(turns);
  if (assistantText >= 0) return assistantText;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn?.content.some((block) => block.type === "tool_result")) return i;
  }
  return turns.length;
}

function toolNames(turns: readonly ConversationTurn[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type === "tool_call") names.set(block.id, block.name);
    }
  }
  return names;
}

function stubText(name: string | undefined): string {
  return name === undefined
    ? "[tool result omitted]"
    : `[${name} result omitted]`;
}

function stubToolResult(
  block: ToolResultBlock,
  names: ReadonlyMap<string, string>,
): { block: ToolResultBlock; stubbed: boolean } {
  const text = stubText(names.get(block.callId));
  if (JSON.stringify(block.content).length <= text.length) {
    return { block, stubbed: false };
  }
  const next: ToolResultBlock = {
    type: "tool_result",
    callId: block.callId,
    content: [{ type: "text", text }],
  };
  if (block.isError === true) next.isError = true;
  return { block: next, stubbed: true };
}

function stubTurn(
  turn: ConversationTurn,
  names: ReadonlyMap<string, string>,
): { turn: ConversationTurn; stubbed: number } {
  let stubbed = 0;
  let changed = false;
  const content = turn.content.map((block) => {
    if (block.type !== "tool_result") return block;
    const next = stubToolResult(block, names);
    if (!next.stubbed) return block;
    changed = true;
    stubbed += 1;
    return next.block;
  });
  return { turn: changed ? { ...turn, content } : turn, stubbed };
}

function shrinkPrompt(turns: ConversationTurn[]): {
  output: ConversationTurn[];
  stubbed: number;
} {
  const boundary = stubBoundary(turns);
  const names = toolNames(turns);
  let stubbed = 0;
  let changed = false;
  const output = turns.map((turn, index) => {
    if (index >= boundary) return turn;
    const next = stubTurn(turn, names);
    stubbed += next.stubbed;
    if (next.turn !== turn) changed = true;
    return next.turn;
  });
  if (!changed) return { output: turns, stubbed: 0 };
  return { output, stubbed };
}

export function createAnthropicCachePromptTransform(
  deps: AnthropicCachePromptDeps,
): ContextTransform {
  return {
    name: STRATEGY,
    version: "1",
    async apply(turns, _ctx) {
      const ttl = cacheTtlMsFor(deps.protocol());
      if (ttl === undefined) return passthrough(turns, "non-anthropic");
      const at = deps.cacheWriteAt();
      if (at !== undefined && deps.nowMs() - at < ttl) {
        return passthrough(turns, "cache-warm");
      }
      const shrunk = shrinkPrompt(turns);
      return {
        output: shrunk.output,
        record: {
          strategy: STRATEGY,
          version: "1",
          parameters: {},
          reason: shrunk.stubbed > 0 ? "stubbed-tool-results" : "noop",
          decisions: { stubbed: shrunk.stubbed },
        },
      };
    },
  };
}
