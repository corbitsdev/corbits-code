import {
  BEARER_CREDENTIAL_SENTINEL,
  ProtocolMismatchError,
  registerProvider,
  type BuiltRequest,
  type ProviderAdapter,
} from "@intx/inference";
import type {
  ContentBlock,
  ConversationTurn,
  InferenceEvent,
  InferenceOptions,
  LastCycleSource,
  PartialMessage,
  TokenUsage,
} from "@intx/types/runtime";
import {
  CODEX_RESPONSES_PATH,
  CODEX_AUTHORIZE_EXTRA_PARAMS,
} from "../auth/codex/constants.js";

// Adapter for the OpenAI Responses API as served by the Codex backend
// (chatgpt.com/backend-api/codex/responses). The Codex backend does NOT speak
// Chat Completions: requests use Responses `input` items + flat tools, and the
// stream is the Responses SSE event protocol. Registered under the provider id
// "codex-responses"; sources for `codex/<profile>` providers are built with
// that id so the harness routes them here instead of the OpenAI adapter.
//
// Credentials and the chatgpt-account-id ride through differently: the access
// token is injected by the harness via the bearer sentinel, while the account
// id and session id travel in `source.defaults.providerOptions` (merged into
// InferenceOptions.providerOptions by the harness) and are lifted into headers
// here. Neither is placed in the request body.

export const CODEX_RESPONSES_PROVIDER = "codex-responses";

// Keys the source stashes in defaults.providerOptions for this adapter.
export const CODEX_ACCOUNT_ID_OPTION = "codexAccountId";
export const CODEX_SESSION_ID_OPTION = "codexSessionId";

const EMPTY_PARTIAL: PartialMessage = { text: "" };

// ---------------------------------------------------------------------------
// Request building — internal turns → Responses `input` items
// ---------------------------------------------------------------------------

type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string };

type ResponsesInputItem =
  | { type: "message"; role: "user" | "assistant" | "system"; content: ResponsesContentPart[] }
  | { type: "function_call"; name: string; arguments: string; call_id: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; summary: never[]; encrypted_content: string };

// Map one internal turn to zero or more Responses items. Assistant text uses
// `output_text` parts; user/system text uses `input_text`. Tool calls become
// `function_call` items (arguments serialized to a JSON string) and tool
// results become `function_call_output` items. Reasoning blocks are echoed
// back only when they carry the opaque `encrypted_content` the backend issued
// (held in a thinking block's signature), which is required for multi-turn
// reasoning continuity.
function toResponsesItems(turn: ConversationTurn): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  const textKind: "input_text" | "output_text" = turn.role === "assistant" ? "output_text" : "input_text";
  const textParts: ResponsesContentPart[] = [];

  const flushText = (): void => {
    if (textParts.length > 0) {
      items.push({ type: "message", role: turn.role, content: [...textParts] });
      textParts.length = 0;
    }
  };

  for (const block of turn.content) {
    if (block.type === "text") {
      textParts.push({ type: textKind, text: block.text } as ResponsesContentPart);
    } else if (block.type === "tool_call") {
      flushText();
      items.push({
        type: "function_call",
        name: block.name,
        arguments: JSON.stringify(block.arguments ?? {}),
        call_id: block.id,
      });
    } else if (block.type === "tool_result") {
      flushText();
      items.push({ type: "function_call_output", call_id: block.callId, output: toolResultText(block) });
    } else if (block.type === "thinking" && typeof block.signature === "string" && block.signature.length > 0) {
      flushText();
      items.push({ type: "reasoning", summary: [], encrypted_content: block.signature });
    }
  }
  flushText();
  return items;
}

// Tool results carry a content array; the Responses API wants a string. Join
// the text parts; non-text content (images, etc.) is not representable here and
// is dropped with a marker so the model is not misled into thinking it is
// missing silently.
function toolResultText(block: Extract<ContentBlock, { type: "tool_result" }>): string {
  const parts: string[] = [];
  for (const c of block.content) {
    if (c.type === "text") parts.push(c.text);
    else parts.push(`[unsupported ${c.type} content omitted]`);
  }
  return parts.join("");
}

function toResponsesTools(options: InferenceOptions): unknown[] | undefined {
  if (options.tools === undefined || options.tools.length === 0) return undefined;
  // Responses function tools are FLAT — name/description/parameters sit beside
  // `type`, not nested under a `function` key (unlike Chat Completions).
  return options.tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
}

function optionString(options: InferenceOptions, key: string): string | undefined {
  const value = options.providerOptions?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildRequest(
  messages: ConversationTurn[],
  model: string,
  options: InferenceOptions,
): BuiltRequest {
  const input = messages.flatMap(toResponsesItems);
  const tools = toResponsesTools(options);
  const accountId = optionString(options, CODEX_ACCOUNT_ID_OPTION);
  const sessionId = optionString(options, CODEX_SESSION_ID_OPTION);

  const body: Record<string, unknown> = {
    model,
    input,
    // The Codex backend requires server-side storage off and streaming on, and
    // asks for encrypted reasoning so it can be round-tripped across turns.
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    parallel_tool_calls: false,
  };
  if (options.systemPrompt !== undefined) body["instructions"] = options.systemPrompt;
  if (tools !== undefined) {
    body["tools"] = tools;
    body["tool_choice"] = "auto";
  }
  // reasoning_effort rides in providerOptions (same place the OpenAI-compatible
  // path reads it); map it onto the Responses `reasoning.effort` field.
  const effort = options.providerOptions?.["reasoning_effort"];
  if (typeof effort === "string" && effort !== "none") {
    body["reasoning"] = { effort, summary: "auto" };
  }
  if (sessionId !== undefined) body["prompt_cache_key"] = sessionId;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: BEARER_CREDENTIAL_SENTINEL,
    "openai-beta": "responses=experimental",
    originator: CODEX_AUTHORIZE_EXTRA_PARAMS["originator"] ?? "codex_cli_rs",
  };
  if (accountId !== undefined) headers["chatgpt-account-id"] = accountId;
  if (sessionId !== undefined) headers["session_id"] = sessionId;

  return { url: CODEX_RESPONSES_PATH, headers, body: JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// Response parsing — Responses SSE events → internal inference events
// ---------------------------------------------------------------------------

// Per-request block indexing. The Responses stream identifies streaming items
// by `item_id`; we allocate one content-block index per distinct item id from
// a shared counter so text, reasoning, and tool-call blocks never collide.
type CodexBlockIndexer = {
  nextIndex: number;
  textIndex: number | null;
  thinkingIndex: number | null;
  itemBlockIndex: Map<string, number>;
};

function getOrAssignTextIndex(state: CodexBlockIndexer): number {
  if (state.textIndex === null) {
    state.textIndex = state.nextIndex;
    state.nextIndex += 1;
  }
  return state.textIndex;
}

function getOrAssignThinkingIndex(state: CodexBlockIndexer): number {
  if (state.thinkingIndex === null) {
    state.thinkingIndex = state.nextIndex;
    state.nextIndex += 1;
  }
  return state.thinkingIndex;
}

function getOrAssignItemIndex(state: CodexBlockIndexer, itemId: string): number {
  const existing = state.itemBlockIndex.get(itemId);
  if (existing !== undefined) return existing;
  const assigned = state.nextIndex;
  state.nextIndex += 1;
  state.itemBlockIndex.set(itemId, assigned);
  return assigned;
}

function usageFromResponse(response: Record<string, unknown>): TokenUsage | undefined {
  const usage = response["usage"];
  if (typeof usage !== "object" || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const inputDetails = u["input_tokens_details"] as Record<string, unknown> | undefined;
  const outputDetails = u["output_tokens_details"] as Record<string, unknown> | undefined;
  return {
    input: num(u["input_tokens"]),
    output: num(u["output_tokens"]),
    cacheRead: num(inputDetails?.["cached_tokens"]),
    cacheWrite: 0,
    thinking: num(outputDetails?.["reasoning_tokens"]),
  };
}

function parseResponse(
  sseData: string,
  indexer: CodexBlockIndexer,
  source: LastCycleSource,
): InferenceEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sseData);
  } catch (cause) {
    throw new ProtocolMismatchError(
      `codex-responses parseResponse: malformed JSON in SSE data payload: ${cause instanceof Error ? cause.message : String(cause)}`,
      sseData,
    );
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const event = parsed as Record<string, unknown>;
  const eventType = event["type"];
  if (typeof eventType !== "string") return [];

  const seq = 0;
  const events: InferenceEvent[] = [];

  switch (eventType) {
    case "response.output_text.delta": {
      const token = event["delta"];
      if (typeof token === "string" && token.length > 0) {
        events.push({
          type: "inference.text.delta",
          seq,
          data: { token, partial: EMPTY_PARTIAL, index: getOrAssignTextIndex(indexer) },
        });
      }
      return events;
    }
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta": {
      const token = event["delta"];
      if (typeof token === "string" && token.length > 0) {
        events.push({
          type: "inference.thinking.delta",
          seq,
          data: { token, partial: EMPTY_PARTIAL, index: getOrAssignThinkingIndex(indexer) },
        });
      }
      return events;
    }
    case "response.output_item.added": {
      const item = event["item"];
      if (typeof item === "object" && item !== null) {
        const it = item as Record<string, unknown>;
        if (it["type"] === "function_call") {
          const itemId = typeof it["id"] === "string" ? it["id"] : undefined;
          const callId = it["call_id"];
          const name = it["name"];
          if (itemId !== undefined && typeof callId === "string" && typeof name === "string") {
            events.push({
              type: "inference.tool_call.start",
              seq,
              data: { callId, name, partial: EMPTY_PARTIAL, index: getOrAssignItemIndex(indexer, itemId) },
            });
          }
        }
      }
      return events;
    }
    case "response.function_call_arguments.delta": {
      const itemId = event["item_id"];
      const fragment = event["delta"];
      if (typeof itemId === "string" && typeof fragment === "string" && fragment.length > 0) {
        const blockIndex = getOrAssignItemIndex(indexer, itemId);
        events.push({
          type: "inference.tool_call.delta",
          seq,
          // The harness routes argument fragments by a per-stream placeholder
          // keyed to the block index registered on the start event.
          data: { callId: String(blockIndex), argumentFragment: fragment, partial: EMPTY_PARTIAL, index: blockIndex },
        });
      }
      return events;
    }
    case "response.completed": {
      const response = event["response"];
      if (typeof response === "object" && response !== null) {
        const usage = usageFromResponse(response as Record<string, unknown>);
        if (usage !== undefined) {
          events.push({ type: "inference.usage", seq, data: { usage, source } });
        }
      }
      return events;
    }
    case "response.failed": {
      const response = event["response"] as Record<string, unknown> | undefined;
      const error = response?.["error"] as Record<string, unknown> | undefined;
      const message = typeof error?.["message"] === "string" ? error["message"] : "Codex response failed";
      throw new ProtocolMismatchError(`codex-responses: ${message}`, parsed);
    }
    case "error": {
      const message = typeof event["message"] === "string" ? event["message"] : "Codex stream error";
      throw new ProtocolMismatchError(`codex-responses: ${message}`, parsed);
    }
    default:
      // Lifecycle envelopes (response.created, response.in_progress,
      // response.output_item.done, content_part.*, *.done) carry no incremental
      // payload the harness needs; ignore them.
      return events;
  }
}

export function createCodexResponsesAdapter(source: LastCycleSource): ProviderAdapter {
  const indexer: CodexBlockIndexer = {
    nextIndex: 0,
    textIndex: null,
    thinkingIndex: null,
    itemBlockIndex: new Map<string, number>(),
  };
  return {
    buildRequest,
    parseResponse: (sseData) => parseResponse(sseData, indexer, source),
  };
}

// Register the adapter under "codex-responses". Idempotent (registerProvider is
// a map set), so calling this from every entry point is safe.
export function registerCodexResponsesAdapter(): void {
  registerProvider(CODEX_RESPONSES_PROVIDER, createCodexResponsesAdapter);
}
