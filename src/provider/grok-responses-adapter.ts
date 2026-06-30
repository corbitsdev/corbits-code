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
import { createResponsesBlockIndexer, parseResponse } from "./codex-responses-adapter.js";

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

type ResponsesInputItem =
  | { type: "message"; role: "user" | "assistant" | "system"; content: string }
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

// Map one internal turn to Responses items. Text blocks collapse into a single
// string-content message (the shape grok sends); tool calls and results become
// function_call / function_call_output items; reasoning blocks are echoed back
// only when they carry the opaque encrypted_content the backend issued.
function toResponsesItems(turn: ConversationTurn): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  const role = turn.role;
  const textChunks: string[] = [];

  const flushText = (): void => {
    if (textChunks.length > 0) {
      items.push({ type: "message", role, content: textChunks.join("") });
      textChunks.length = 0;
    }
  };

  for (const block of turn.content) {
    if (block.type === "text") {
      textChunks.push(block.text);
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

function buildRequest(
  messages: ConversationTurn[],
  model: string,
  options: InferenceOptions,
): BuiltRequest {
  const conversation = messages.flatMap(toResponsesItems);
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
    buildRequest,
    parseResponse: (sseData) => parseResponse(sseData, indexer, source, GROK_RESPONSES_PROVIDER),
  };
}
