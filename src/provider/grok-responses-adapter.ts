import {
  BEARER_CREDENTIAL_SENTINEL,
  encodeToolName,
  type BuiltRequest,
  type ProviderAdapter,
} from "@intx/inference";
import type {
  ContentBlock,
  ConversationTurn,
  InferenceOptions,
  LastCycleSource,
} from "@intx/types/runtime";
import {
  XAI_RESPONSES_PATH,
  XAI_CLIENT_IDENTIFIER,
  XAI_CLIENT_VERSION,
  XAI_USER_AGENT,
} from "../auth/xai/constants.js";
import {
  RESPONSES_TOOL_NAME_LIMIT,
  createResponsesBlockIndexer,
  parseJSONResponse,
  parseResponse,
  signatureForModel,
} from "./codex-responses-adapter.js";

// Adapter for the grok-cli OAuth proxy (cli-chat-proxy.grok.com), which serves
// the OpenAI Responses API at /v1/responses. The request shape mirrors the grok
// CLI's own /v1/responses call (captured live): the system prompt rides as a
// leading `system` input message (string content, not parts), reasoning is
// requested by summary, and the caller is identified by x-grok-* headers rather
// than a body field. The Responses SSE protocol is identical to Codex, so the
// stream parser is shared.

export const GROK_RESPONSES_PROVIDER = "grok-responses";

// Keys the source stashes in defaults.providerOptions for this adapter.
export const GROK_USER_ID_OPTION = "grokUserId";
export const GROK_SESSION_ID_OPTION = "grokSessionId";

type ResponsesInputContentPart =
  { type: "input_text"; text: string } | { type: "input_image"; image_url: string };

type ResponsesInputItem =
  | {
      type: "message";
      role: "user" | "assistant" | "system";
      content: string | ResponsesInputContentPart[];
    }
  | { type: "function_call"; name: string; arguments: string; call_id: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; summary: never[]; encrypted_content: string };

function toolResultText(block: Extract<ContentBlock, { type: "tool_result" }>): string {
  const parts: string[] = [];
  for (const c of block.content) {
    if (c.type === "text") parts.push(c.text);
    else parts.push(`[unsupported ${c.type} content omitted]`);
  }
  return parts.join("");
}

// Map one internal turn to Responses items. Text-only messages keep the string
// shape grok sends; messages with image blocks switch to Responses content parts
// so the model receives the actual pixels instead of only a text placeholder.
function toResponsesItems(
  turn: ConversationTurn,
  requestModel: string,
  requestProvider: string,
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  const role = turn.role;
  const parts: ResponsesInputContentPart[] = [];
  let hasImage = false;
  // See codex-responses-adapter.ts toResponsesItems for why an unreplayed
  // reasoning item suppresses the function_call(s) it produced.
  let suppressOrphanedCalls = false;

  const flushMessage = (): void => {
    if (parts.length === 0) return;
    items.push({
      type: "message",
      role,
      content: hasImage
        ? [...parts]
        : parts.map((part) => (part.type === "input_text" ? part.text : "")).join(""),
    });
    parts.length = 0;
    hasImage = false;
    suppressOrphanedCalls = false;
  };

  for (const block of turn.content) {
    if (block.type === "text") {
      parts.push({ type: "input_text", text: block.text });
    } else if (block.type === "image") {
      if (block.source.kind === "base64") {
        hasImage = true;
        parts.push({
          type: "input_image",
          image_url: `data:${block.source.mimeType};base64,${block.source.data}`,
        });
      } else if (block.source.kind === "url") {
        hasImage = true;
        parts.push({ type: "input_image", image_url: block.source.url });
      } else {
        parts.push({
          type: "input_text",
          text: `[Unsupported image reference omitted: ${block.source.reference}]`,
        });
      }
    } else if (block.type === "tool_call") {
      if (suppressOrphanedCalls) continue;
      flushMessage();
      items.push({
        type: "function_call",
        name: encodeToolName(block.name, RESPONSES_TOOL_NAME_LIMIT),
        arguments: JSON.stringify(block.arguments ?? {}),
        call_id: block.id,
      });
    } else if (block.type === "tool_result") {
      flushMessage();
      suppressOrphanedCalls = false;
      items.push({
        type: "function_call_output",
        call_id: block.callId,
        output: toolResultText(block),
      });
    } else if (
      block.type === "thinking" &&
      typeof block.signature === "string" &&
      block.signature.length > 0
    ) {
      flushMessage();
      const encryptedContent = signatureForModel(
        turn,
        requestModel,
        requestProvider,
        block.signature,
      );
      if (encryptedContent !== undefined) {
        items.push({ type: "reasoning", summary: [], encrypted_content: encryptedContent });
        suppressOrphanedCalls = false;
      } else {
        suppressOrphanedCalls = true;
      }
    }
  }
  flushMessage();
  return items;
}

function toResponsesTools(options: InferenceOptions): unknown[] | undefined {
  if (options.tools === undefined || options.tools.length === 0) return undefined;
  return options.tools.map((t) => ({
    type: "function",
    name: encodeToolName(t.name, RESPONSES_TOOL_NAME_LIMIT),
    description: t.description,
    parameters: t.inputSchema,
  }));
}

function optionString(options: InferenceOptions, key: string): string | undefined {
  const value = options.providerOptions?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Keeps the LAST occurrence of each duplicate function_call / function_call_output
// call_id, not the first: a duplicate is most often a corrected retry, and
// discarding the retry in favor of the stale original silently replays the
// wrong tool result. Both item types are covered — a duplicated function_call
// is just as invalid on the wire as a duplicated output.
function dedupeToolItems(items: ResponsesInputItem[]): ResponsesInputItem[] {
  const lastIndexForCall = new Map<string, number>();
  items.forEach((item, i) => {
    if (item.type === "function_call" || item.type === "function_call_output") {
      lastIndexForCall.set(`${item.type}:${item.call_id}`, i);
    }
  });
  return items.filter((item, i) => {
    if (item.type === "function_call" || item.type === "function_call_output") {
      return lastIndexForCall.get(`${item.type}:${item.call_id}`) === i;
    }
    return true;
  });
}

function buildRequest(
  messages: ConversationTurn[],
  model: string,
  options: InferenceOptions,
  requestProvider: string,
): BuiltRequest {
  const conversation = dedupeToolItems(
    messages.flatMap((turn) => toResponsesItems(turn, model, requestProvider)),
  );
  const systemMessage: ResponsesInputItem | undefined =
    options.systemPrompt !== undefined
      ? { type: "message", role: "system", content: options.systemPrompt }
      : undefined;
  const input = systemMessage !== undefined ? [systemMessage, ...conversation] : conversation;
  const tools = toResponsesTools(options);

  const reasoning: { summary: "detailed"; effort?: string } = { summary: "detailed" };
  const effort = optionString(options, "reasoning_effort");
  if (effort !== undefined) reasoning.effort = effort;

  const body: Record<string, unknown> = {
    model,
    input,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    // "detailed" streams denser summary deltas than "auto". Grok bills full
    // thinking tokens but only returns summarized text; sparse auto summaries
    // left the stall/activity clocks quiet for 60–120s mid-think. Effort is
    // forwarded when the source set it — this adapter does not invent a default.
    reasoning,
  };
  if (tools !== undefined) {
    body["tools"] = tools;
    body["tool_choice"] = "auto";
  }
  // With store:false this is the only cache-routing signal; keying it to the
  // inference thread's session id keeps every request on the same cache shard.
  const sessionId = optionString(options, GROK_SESSION_ID_OPTION);
  if (sessionId !== undefined) body["prompt_cache_key"] = sessionId;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: BEARER_CREDENTIAL_SENTINEL,
    "user-agent": XAI_USER_AGENT,
    "x-grok-client-identifier": XAI_CLIENT_IDENTIFIER,
    "x-grok-client-version": XAI_CLIENT_VERSION,
    "x-grok-model-override": model,
  };
  const userId = optionString(options, GROK_USER_ID_OPTION);
  if (userId !== undefined) headers["x-grok-user-id"] = userId;

  return { url: XAI_RESPONSES_PATH, headers, body: JSON.stringify(body) };
}

export function createGrokResponsesAdapter(source: LastCycleSource): ProviderAdapter {
  // Re-created per request in buildRequest — see codex-responses-adapter.ts.
  let indexer = createResponsesBlockIndexer();
  return {
    buildRequest: (messages, model, options) => {
      indexer = createResponsesBlockIndexer();
      return buildRequest(messages, model, options, source.provider);
    },
    parseResponse: (sseData) => parseResponse(sseData, indexer, source, GROK_RESPONSES_PROVIDER),
    parseJSONResponse,
  };
}
