import {
  BEARER_CREDENTIAL_SENTINEL,
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

// Key the source stashes in defaults.providerOptions for this adapter.
export const GROK_USER_ID_OPTION = "grokUserId";

type ResponsesInputContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

type ResponsesInputItem =
  | { type: "message"; role: "user" | "assistant" | "system"; content: string | ResponsesInputContentPart[] }
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
function toResponsesItems(turn: ConversationTurn, requestModel: string, requestProvider: string): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  const role = turn.role;
  const parts: ResponsesInputContentPart[] = [];
  let hasImage = false;

  const flushMessage = (): void => {
    if (parts.length === 0) return;
    items.push({
      type: "message",
      role,
      content: hasImage ? [...parts] : parts.map((part) => part.type === "input_text" ? part.text : "").join(""),
    });
    parts.length = 0;
    hasImage = false;
  };

  for (const block of turn.content) {
    if (block.type === "text") {
      parts.push({ type: "input_text", text: block.text });
    } else if (block.type === "image") {
      if (block.source.kind === "base64") {
        hasImage = true;
        parts.push({ type: "input_image", image_url: `data:${block.source.mimeType};base64,${block.source.data}` });
      } else if (block.source.kind === "url") {
        hasImage = true;
        parts.push({ type: "input_image", image_url: block.source.url });
      } else {
        parts.push({ type: "input_text", text: `[Unsupported image reference omitted: ${block.source.reference}]` });
      }
    } else if (block.type === "tool_call") {
      flushMessage();
      items.push({
        type: "function_call",
        name: block.name,
        arguments: JSON.stringify(block.arguments ?? {}),
        call_id: block.id,
      });
    } else if (block.type === "tool_result") {
      flushMessage();
      items.push({ type: "function_call_output", call_id: block.callId, output: toolResultText(block) });
    } else if (block.type === "thinking" && typeof block.signature === "string" && block.signature.length > 0) {
      flushMessage();
      const encryptedContent = signatureForModel(turn, requestModel, requestProvider, block.signature);
      if (encryptedContent !== undefined) {
        items.push({ type: "reasoning", summary: [], encrypted_content: encryptedContent });
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
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
}

function optionString(options: InferenceOptions, key: string): string | undefined {
  const value = options.providerOptions?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function dedupeToolOutputs(items: ResponsesInputItem[]): ResponsesInputItem[] {
  const seen = new Set<string>();
  const deduped: ResponsesInputItem[] = [];
  for (const item of items) {
    if (item.type === "function_call_output") {
      if (seen.has(item.call_id)) continue;
      seen.add(item.call_id);
    }
    deduped.push(item);
  }
  return deduped;
}

function buildRequest(
  messages: ConversationTurn[],
  model: string,
  options: InferenceOptions,
  requestProvider: string,
): BuiltRequest {
  const conversation = dedupeToolOutputs(messages.flatMap((turn) => toResponsesItems(turn, model, requestProvider)));
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
  const indexer = createResponsesBlockIndexer();
  return {
    buildRequest: (messages, model, options) => buildRequest(messages, model, options, source.provider),
    parseResponse: (sseData) => parseResponse(sseData, indexer, source, GROK_RESPONSES_PROVIDER),
    parseJSONResponse,
  };
}
