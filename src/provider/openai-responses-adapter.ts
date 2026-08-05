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
  createResponsesBlockIndexer,
  isResponsesStreamTerminal,
  parseResponse,
} from "./codex-responses-adapter.js";

// Generic OpenAI Responses API adapter (POST /responses). Used by OpenCode Go
// models that speak Responses rather than Chat Completions (e.g. gpt-5.6-luna).
// Shares the Codex/Grok SSE parser; only the request shape and path differ from
// Chat Completions and from the Grok-specific header set.

export const OPENAI_RESPONSES_PROVIDER = "openai-responses";

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

function toResponsesItems(turn: ConversationTurn): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  const role = turn.role;
  const parts: ResponsesInputContentPart[] = [];
  let hasImage = false;

  const flushMessage = (): void => {
    if (parts.length === 0) return;
    items.push({
      type: "message",
      role,
      content: hasImage ? [...parts] : parts.map((part) => (part.type === "input_text" ? part.text : "")).join(""),
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
      items.push({ type: "reasoning", summary: [], encrypted_content: block.signature });
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
): BuiltRequest {
  const conversation = dedupeToolOutputs(messages.flatMap(toResponsesItems));
  const systemMessage: ResponsesInputItem | undefined =
    options.systemPrompt !== undefined
      ? { type: "message", role: "system", content: options.systemPrompt }
      : undefined;
  const input = systemMessage !== undefined ? [systemMessage, ...conversation] : conversation;
  const tools = toResponsesTools(options);

  const body: Record<string, unknown> = {
    model,
    input,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    reasoning: { summary: "auto" },
  };
  if (tools !== undefined) {
    body["tools"] = tools;
    body["tool_choice"] = "auto";
  }
  if (options.maxTokens !== undefined) body["max_output_tokens"] = options.maxTokens;
  if (options.temperature !== undefined) body["temperature"] = options.temperature;

  return {
    url: "/responses",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: BEARER_CREDENTIAL_SENTINEL,
    },
    body: JSON.stringify(body),
  };
}

export function createOpenAIResponsesAdapter(source: LastCycleSource): ProviderAdapter {
  const indexer = createResponsesBlockIndexer();
  return {
    buildRequest,
    parseResponse: (sseData) => parseResponse(sseData, indexer, source, OPENAI_RESPONSES_PROVIDER),
    isStreamTerminal: isResponsesStreamTerminal,
  };
}
