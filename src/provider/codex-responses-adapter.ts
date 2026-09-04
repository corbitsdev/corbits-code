import {
  BEARER_CREDENTIAL_SENTINEL,
  ProtocolMismatchError,
  decodeToolName,
  encodeToolName,
  type BuiltRequest,
  type ProviderAdapter,
  type ToolNameLimit,
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
import { CODEX_RESPONSES_PATH, CODEX_AUTHORIZE_EXTRA_PARAMS } from "../auth/codex/constants.js";
import { codexInstructions } from "../auth/codex/instructions.js";
import { PRODUCT_NAME, ENVIRONMENT_TAG_NAME } from "../branding.js";

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
// InferenceOptions.providerOptions by the harness). Account id is headers-only
// (`chatgpt-account-id`). Session id is the `session_id` header and
// `prompt_cache_key` in the body — the only cache-routing signal under
// `store: false`.
//
// Continuity is not Responses store chaining. The ChatGPT Codex backend
// requires `store: false` (`store: true` → 400) and rejects
// `previous_response_id`. Every turn resends the full `input`; encrypted
// reasoning captured from the prior stream is resent as a `reasoning` item.

export const CODEX_RESPONSES_PROVIDER = "codex-responses";

// Keys the source stashes in defaults.providerOptions for this adapter.
export const CODEX_ACCOUNT_ID_OPTION = "codexAccountId";
export const CODEX_SESSION_ID_OPTION = "codexSessionId";

const EMPTY_PARTIAL: PartialMessage = { text: "" };

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function requestURL(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

// Content type the request's accept header committed to, or null when the
// commitment is ambiguous. Reads init headers first, falling back to a
// Request object's own headers so both fetch calling conventions are
// honored. Media types are prefix-matched per comma-separated entry so
// parameters do not defeat the match; a list naming BOTH supported
// protocols is ambiguous and yields null.
function acceptedContentType(
  input: string | URL | Request,
  init: RequestInit | undefined,
): string | null {
  const headers =
    init?.headers !== undefined
      ? new Headers(init.headers)
      : input instanceof Request
        ? input.headers
        : undefined;
  const accept = headers?.get("accept");
  if (accept === undefined || accept === null) return null;
  const supported = new Set<string>();
  for (const entry of accept.toLowerCase().split(",")) {
    const media = entry.trim();
    if (media.startsWith("text/event-stream")) supported.add("text/event-stream");
    else if (media.startsWith("application/json")) supported.add("application/json");
  }
  if (supported.size !== 1) return null;
  return [...supported][0] ?? null;
}

// The Codex backend omits the Content-Type header entirely on some model
// streams (observed live with the gpt-5.6 family) while the body is a valid
// SSE stream. The vendored harness detects the response protocol from that
// header alone and fails the turn when it is absent, so the header is
// restored here — at the fetch boundary Corbits owns, scoped to Codex
// responses requests — from the protocol the request's accept header
// declared. Responses that declare any Content-Type, non-2xx responses, and
// requests whose accept header is ambiguous pass through untouched, keeping
// the harness's loud protocol-mismatch failure for genuine violations.
export function withCodexContentTypeRepair(fetchImpl: FetchLike): FetchLike {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!requestURL(input).endsWith(CODEX_RESPONSES_PATH)) return response;
    if (!response.ok) return response;
    if (response.headers.get("content-type") !== null) return response;
    const declared = acceptedContentType(input, init);
    if (declared === null) return response;
    const headers = new Headers(response.headers);
    headers.set("content-type", declared);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

// ---------------------------------------------------------------------------
// Request building — internal turns → Responses `input` items
// ---------------------------------------------------------------------------

type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string };

type ResponsesInputItem =
  | {
      type: "message";
      role: "user" | "assistant" | "system" | "developer";
      content: ResponsesContentPart[];
    }
  | { type: "function_call"; name: string; arguments: string; call_id: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; summary: never[]; encrypted_content: string };

// A thinking block's `signature` is opaque ciphertext a specific backend
// issued for a specific model; only that backend can decrypt it. `model` is
// arbitrary catalog/user-supplied text — nothing stops two distinct backends
// (proxy aliases, two OpenAI-compatible endpoints) from declaring the same
// literal model name, so comparing `turn.model` alone treats a foreign
// signature as safe to replay. `ConversationTurn` carries no field for which
// provider produced it, so provenance rides inside the signature string
// itself: capture tags it `<provider>:<ciphertext>` (see `tagSignature`),
// and replay only unwraps the ciphertext when both the tagged provider and
// the model match the current request.
//
// Provider, not the per-account source id, is the unit of decrypt
// capability — a Codex backend shared across ChatGPT accounts can decrypt a
// signature issued to any of them, so keying on provider (rather than source
// id) is what lets an account switch keep reasoning continuity while a
// genuine cross-provider collision still gets dropped. A poisoned history
// self-heals on the next request instead of being replayed forever.
const SIGNATURE_TAG_SEPARATOR = ":";

export function tagSignature(provider: string, encryptedContent: string): string {
  return `${provider}${SIGNATURE_TAG_SEPARATOR}${encryptedContent}`;
}

function untagSignature(
  tagged: string,
): { provider: string; encryptedContent: string } | undefined {
  const idx = tagged.indexOf(SIGNATURE_TAG_SEPARATOR);
  if (idx === -1) return undefined;
  return { provider: tagged.slice(0, idx), encryptedContent: tagged.slice(idx + 1) };
}

export function signatureForModel(
  turn: ConversationTurn,
  requestModel: string,
  requestProvider: string,
  signature: string,
): string | undefined {
  // `model` is optional on the persisted turn schema; a turn saved before that
  // field existed (or otherwise missing it) is not evidence of a model
  // switch — treat the absence as benign and fall through to the provider
  // check, rather than dropping reasoning that never actually crossed models.
  if (turn.model !== undefined && turn.model !== requestModel) return undefined;
  const tagged = untagSignature(signature);
  if (tagged === undefined) return undefined;
  return tagged.provider === requestProvider ? tagged.encryptedContent : undefined;
}

// Map one internal turn to zero or more Responses items. Assistant text uses
// `output_text` parts; user/system text uses `input_text`. Tool calls become
// `function_call` items (arguments serialized to a JSON string) and tool
// results become `function_call_output` items. Reasoning blocks are echoed
// back only when they carry the opaque `encrypted_content` the backend issued
// (held in a thinking block's signature) AND that backend is the one this
// request is going to — replaying it to a different provider gets a 400 it
// cannot recover from.
// Wire-charset limit for function names on the Responses surface (Codex,
// Grok, and the generic OpenAI Responses adapter all share OpenAI's
// `^[a-zA-Z0-9_-]{1,64}$` function-name charset).
export const RESPONSES_TOOL_NAME_LIMIT: ToolNameLimit = {
  provider: "responses",
  maxLength: 64,
};

function toResponsesItems(
  turn: ConversationTurn,
  requestModel: string,
  requestProvider: string,
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  const textKind: "input_text" | "output_text" =
    turn.role === "assistant" ? "output_text" : "input_text";
  const textParts: ResponsesContentPart[] = [];
  // A reasoning block whose signature we could not replay (foreign provider,
  // model switch, or a missing/untagged signature) leaves any function_call
  // it produced without the reasoning item the Responses API expects to
  // precede it — the exact orphaned shape that degenerates reasoning models.
  // Suppress function_call items until the next text or successfully-replayed
  // reasoning item re-establishes a clean turn shape; tool results are
  // unaffected since they never need a preceding reasoning item.
  let suppressOrphanedCalls = false;

  const flushText = (): void => {
    if (textParts.length > 0) {
      items.push({ type: "message", role: turn.role, content: [...textParts] });
      textParts.length = 0;
      suppressOrphanedCalls = false;
    }
  };

  for (const block of turn.content) {
    if (block.type === "text") {
      textParts.push({ type: textKind, text: block.text } as ResponsesContentPart);
    } else if (block.type === "image") {
      if (block.source.kind === "base64") {
        textParts.push({
          type: "input_image",
          image_url: `data:${block.source.mimeType};base64,${block.source.data}`,
        });
      } else if (block.source.kind === "url") {
        textParts.push({ type: "input_image", image_url: block.source.url });
      } else {
        textParts.push({
          type: textKind,
          text: `[Unsupported image reference omitted: ${block.source.reference}]`,
        } as ResponsesContentPart);
      }
    } else if (block.type === "tool_call") {
      if (suppressOrphanedCalls) continue;
      flushText();
      items.push({
        type: "function_call",
        name: encodeToolName(block.name, RESPONSES_TOOL_NAME_LIMIT),
        arguments: JSON.stringify(block.arguments ?? {}),
        call_id: block.id,
      });
    } else if (block.type === "tool_result") {
      flushText();
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
      flushText();
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
    name: encodeToolName(t.name, RESPONSES_TOOL_NAME_LIMIT),
    description: t.description,
    parameters: t.inputSchema,
  }));
}

function optionString(options: InferenceOptions, key: string): string | undefined {
  const value = options.providerOptions?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// `instructions` is pinned to the official Codex prompt (the backend rejects
// anything else), so Corbits Code's operating prompt rides as a leading developer
// message that also reconciles the Codex prompt's tool references with the
// proxies actually wired up here. The function tools sent with the request are
// authoritative for names/schemas; this text only resolves which dialect to speak.
function bridgeMessage(systemPrompt: string): ResponsesInputItem {
  const text = `<${ENVIRONMENT_TAG_NAME} priority="0">
${PRODUCT_NAME} is the harness, not the Codex CLI. The Codex tools named above (apply_patch, update_plan, shell) proxy onto ${PRODUCT_NAME}'s native tools with the same permissions — prefer whichever name appears in the current tool list. These operating instructions are authoritative where they differ from the base instructions:

${systemPrompt}
</${ENVIRONMENT_TAG_NAME}>`;
  return { type: "message", role: "developer", content: [{ type: "input_text", text }] };
}

function buildRequest(
  messages: ConversationTurn[],
  model: string,
  options: InferenceOptions,
  requestProvider: string,
): BuiltRequest {
  const conversation = messages.flatMap((turn) => toResponsesItems(turn, model, requestProvider));
  // Corbits Code's prompt cannot live in `instructions` (the backend pins that to
  // the official Codex prompt), so it leads the input as a developer message.
  const input =
    options.systemPrompt !== undefined
      ? [bridgeMessage(options.systemPrompt), ...conversation]
      : conversation;
  const tools = toResponsesTools(options);
  const accountId = optionString(options, CODEX_ACCOUNT_ID_OPTION);
  const sessionId = optionString(options, CODEX_SESSION_ID_OPTION);

  const body: Record<string, unknown> = {
    model,
    input,
    instructions: codexInstructions(),
    // The Codex ChatGPT backend requires `store: false` (store:true → 400) and
    // rejects `previous_response_id` as an unsupported parameter. Multi-turn
    // continuity is full input plus encrypted reasoning round-trip only — do
    // not attempt response-id chaining on this surface.
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    // Serial at the request layer. The reactor already executes a multi-call
    // batch concurrently; this flag is what the ChatGPT Codex backend is sent.
    // Do not flip without verifying the backend accepts true — unlike store /
    // previous_response_id there is no recorded 400.
    parallel_tool_calls: false,
  };
  // The Codex backend rejects `max_output_tokens`; it is intentionally omitted.
  if (tools !== undefined) {
    body["tools"] = tools;
    body["tool_choice"] = "auto";
  }
  // reasoning_effort rides in providerOptions (same place the OpenAI-compatible
  // path reads it); map it onto the Responses `reasoning.effort` field.
  // ChatGPT Codex rejects summary:"auto" for gpt-5.6-terra / gpt-5.3-codex
  // family (HTTP 400; supported: concise | detailed | none). Codex CLI catalog
  // default_reasoning_summary is none — send effort only (CL-6893).
  const effort = options.providerOptions?.["reasoning_effort"];
  if (typeof effort === "string" && effort !== "none") {
    body["reasoning"] = { effort };
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

// Per-request block indexing. The Responses stream tags every streaming item
// with an `item_id`, so we allocate one content-block index per distinct item
// id (regardless of kind). Keying by item id — rather than one sticky index per
// kind — preserves true arrival order when reasoning, text, and tool calls
// interleave, and lets `response.output_item.done` attach an encrypted-reasoning
// signature to the exact thinking block it belongs to. `kind` is recorded so a
// signature is only emitted against a real thinking block.
type CodexBlockKind = "text" | "thinking" | "tool_call";
export interface CodexBlockIndexer {
  nextIndex: number;
  items: Map<string, { index: number; kind: CodexBlockKind }>;
}

// Both the Codex and grok backends speak the same Responses SSE protocol, so
// the parser is shared. Each adapter creates its own indexer per request.
export function createResponsesBlockIndexer(): CodexBlockIndexer {
  return { nextIndex: 0, items: new Map<string, { index: number; kind: CodexBlockKind }>() };
}

function blockIndexFor(state: CodexBlockIndexer, itemId: string, kind: CodexBlockKind): number {
  const existing = state.items.get(itemId);
  if (existing !== undefined) return existing.index;
  const index = state.nextIndex;
  state.nextIndex += 1;
  state.items.set(itemId, { index, kind });
  return index;
}

function usageFromResponse(response: Record<string, unknown>): TokenUsage | undefined {
  const usage = response["usage"];
  if (typeof usage !== "object" || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const inputDetails = u["input_tokens_details"] as Record<string, unknown> | undefined;
  const outputDetails = u["output_tokens_details"] as Record<string, unknown> | undefined;
  // Responses-API `input_tokens` counts the full prompt and `cached_tokens`
  // is a subset of it. Downstream consumers (context meter, compaction
  // governor, faremeter) treat the TokenUsage fields as non-overlapping and
  // sum them, so the cached subset must be split out of input here — emitting
  // the wire counts verbatim double-counts every cached token and inflates
  // context occupancy up to ~2x on high cache-hit sessions.
  const totalInputTokens = num(u["input_tokens"]);
  const cachedTokens = num(inputDetails?.["cached_tokens"]);
  return {
    input: Math.max(0, totalInputTokens - cachedTokens),
    output: num(u["output_tokens"]),
    cacheRead: cachedTokens,
    // OpenAI does not charge for writing to the prompt cache, so the public
    // Responses API usually omits a write count; read it defensively under
    // `cache_creation_tokens` in case a gateway/proxy in front of this
    // OpenAI-shaped endpoint (Codex, Grok) reports one, rather than always
    // hardcoding zero.
    cacheWrite: num(inputDetails?.["cache_creation_tokens"]),
    thinking: num(outputDetails?.["reasoning_tokens"]),
  };
}

export function parseResponse(
  sseData: string,
  indexer: CodexBlockIndexer,
  source: LastCycleSource,
  label = "codex-responses",
): InferenceEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sseData);
  } catch (cause) {
    throw new ProtocolMismatchError(
      `${label} parseResponse: malformed JSON in SSE data payload: ${cause instanceof Error ? cause.message : String(cause)}`,
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
      const itemId =
        typeof event["item_id"] === "string" ? (event["item_id"] as string) : "__text__";
      if (typeof token === "string" && token.length > 0) {
        events.push({
          type: "inference.text.delta",
          seq,
          data: { token, partial: EMPTY_PARTIAL, index: blockIndexFor(indexer, itemId, "text") },
        });
      }
      return events;
    }
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta": {
      // Always register the block and emit a thinking delta (even for empty
      // tokens). This ensures a preceding thinking block exists for any
      // subsequent signature, supporting reasoning items whose visible
      // summary may be empty or delivered only via the done envelope.
      const token = event["delta"];
      const itemId =
        typeof event["item_id"] === "string" ? (event["item_id"] as string) : "__thinking__";
      const index = blockIndexFor(indexer, itemId, "thinking");
      const tok = typeof token === "string" ? token : "";
      events.push({
        type: "inference.thinking.delta",
        seq,
        data: { token: tok, partial: EMPTY_PARTIAL, index },
      });
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
              data: {
                callId,
                name: decodeToolName(name),
                partial: EMPTY_PARTIAL,
                index: blockIndexFor(indexer, itemId, "tool_call"),
              },
            });
          }
        } else if (it["type"] === "reasoning") {
          // Pre-register reasoning items on added so the index is stable
          // even if no text deltas follow (pure-encrypted case).
          const itemId = typeof it["id"] === "string" ? (it["id"] as string) : undefined;
          if (itemId !== undefined) {
            const index = blockIndexFor(indexer, itemId, "thinking");
            events.push({
              type: "inference.thinking.delta",
              seq,
              data: { token: "", partial: EMPTY_PARTIAL, index },
            });
          }
        }
      }
      return events;
    }
    case "response.output_item.done": {
      // Capture the encrypted reasoning blob (signature) so it can be echoed
      // back on the next turn. Required for multi-turn continuity when the
      // backend uses store:false + reasoning.encrypted_content.
      // We ensure a thinking block exists (emitting an empty delta if this
      // is the first signal for the item) so the harness can attach the
      // signature without ProtocolMismatchError.
      const item = event["item"] as Record<string, unknown> | undefined;
      if (
        item?.["type"] === "reasoning" &&
        typeof item["id"] === "string" &&
        typeof item["encrypted_content"] === "string"
      ) {
        const itemId = item["id"] as string;
        const hadPrior = indexer.items.has(itemId);
        const index = blockIndexFor(indexer, itemId, "thinking");
        if (!hadPrior) {
          events.push({
            type: "inference.thinking.delta",
            seq,
            data: { token: "", partial: EMPTY_PARTIAL, index },
          });
        }
        events.push({
          type: "inference.block.signature",
          seq,
          data: {
            signature: tagSignature(source.provider, item["encrypted_content"] as string),
            index,
          },
        });
      }
      return events;
    }
    case "response.function_call_arguments.delta": {
      const itemId = event["item_id"];
      const fragment = event["delta"];
      if (typeof itemId === "string" && typeof fragment === "string" && fragment.length > 0) {
        const blockIndex = blockIndexFor(indexer, itemId, "tool_call");
        events.push({
          type: "inference.tool_call.delta",
          seq,
          // The harness routes argument fragments by a per-stream placeholder
          // keyed to the block index registered on the start event.
          data: {
            callId: String(blockIndex),
            argumentFragment: fragment,
            partial: EMPTY_PARTIAL,
            index: blockIndex,
          },
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
      const message = typeof error?.["message"] === "string" ? error["message"] : "response failed";
      throw new ProtocolMismatchError(`${label}: ${message}`, parsed);
    }
    case "error": {
      const message = typeof event["message"] === "string" ? event["message"] : "stream error";
      throw new ProtocolMismatchError(`${label}: ${message}`, parsed);
    }
    default:
      // Lifecycle envelopes (response.created, response.in_progress,
      // content_part.*, *_text.done) carry no incremental payload the harness
      // needs; ignore them.
      return events;
  }
}

// The Responses stream ends on a semantic lifecycle event, not `[DONE]` or a
// socket close: `response.completed` on success, `response.incomplete` when the
// backend truncates, `response.done` as an alias some backends emit. The
// harness reads this to stop the loop once the terminal event is processed;
// failure envelopes (`response.failed`, `error`) already throw in
// `parseResponse`, which terminates the loop through the harness's catch.
const RESPONSES_TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.incomplete",
  "response.done",
]);

// The Responses adapters in this file always request `stream: true`
// (buildRequest sets it unconditionally), so a non-streaming JSON body
// reaching the harness means the response kind was misdetected or the
// provider ignored the streaming request — a protocol violation, not a
// supported code path to parse.
export function parseJSONResponse(): never {
  throw new ProtocolMismatchError(
    "responses adapter: received a non-streaming JSON response, but this adapter always requests stream: true",
  );
}

export function isResponsesStreamTerminal(sseData: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sseData);
  } catch {
    // parseResponse re-parses the same payload and raises the protocol error;
    // reporting "not terminal" here defers to that single throw site.
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const eventType = (parsed as Record<string, unknown>)["type"];
  return typeof eventType === "string" && RESPONSES_TERMINAL_EVENTS.has(eventType);
}

export function createCodexResponsesAdapter(source: LastCycleSource): ProviderAdapter {
  // Re-created per request in buildRequest, not just once here — otherwise
  // block indices accumulate across every request the adapter instance ever
  // serves, growing the map for the life of the conversation.
  let indexer: CodexBlockIndexer = createResponsesBlockIndexer();
  return {
    buildRequest: (messages, model, options) => {
      indexer = createResponsesBlockIndexer();
      return buildRequest(messages, model, options, source.provider);
    },
    parseResponse: (sseData) => parseResponse(sseData, indexer, source),
    parseJSONResponse,
    isStreamTerminal: isResponsesStreamTerminal,
  };
}
