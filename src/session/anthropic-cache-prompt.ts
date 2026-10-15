// Prompt-only shrink after an Anthropic ephemeral cache write expires.
// Compaction rewrites turns.jsonl and keeps a raw tail, so the next infer
// still cache-writes those tool bodies. Runs inside executeInfer: its output
// is what gets written to prompt.jsonl. Never writes turns and never calls
// the compaction governor.

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
  /** When omitted, the shrink is on. Settings pass false unless opted in. */
  enabled?: () => boolean;
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

// One forward pass collects everything shrinkPrompt needs: every tool_call
// id→name (a result's call turn can sit anywhere, so names span the whole
// transcript), the newest assistant text index, and the last tool_result
// index. The boundary is that text index when one exists, else the last
// result turn (the unconsumed suffix stays whole when the model has not
// written text yet), else the whole history.
function stubSetup(turns: readonly ConversationTurn[]): {
  names: Map<string, string>;
  boundary: number;
} {
  const names = new Map<string, string>();
  let newestAssistantText = -1;
  let lastToolResult = -1;
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn === undefined) continue;
    let hasText = false;
    for (const block of turn.content) {
      if (block.type === "tool_call") names.set(block.id, block.name);
      else if (block.type === "tool_result") lastToolResult = i;
      else if (block.type === "text" && block.text.length > 0) hasText = true;
    }
    if (hasText && turn.role === "assistant") newestAssistantText = i;
  }
  const boundary =
    newestAssistantText >= 0
      ? newestAssistantText
      : lastToolResult >= 0
        ? lastToolResult
        : turns.length;
  return { names, boundary };
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
  const { names, boundary } = stubSetup(turns);
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
      if (deps.enabled !== undefined && !deps.enabled()) {
        return passthrough(turns, "disabled");
      }
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
