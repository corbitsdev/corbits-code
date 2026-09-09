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
import { CODEX_AUTHORIZE_EXTRA_PARAMS, CODEX_RESPONSES_PATH } from "../auth/codex/constants.js";
import {
  XAI_CLIENT_IDENTIFIER,
  XAI_CLIENT_VERSION,
  XAI_RESPONSES_PATH,
  XAI_USER_AGENT,
} from "../auth/xai/constants.js";

// Adapters for the OpenAI Responses API (POST /responses) as served by three
// backends that do NOT speak Chat Completions:
//   - codex-responses: the ChatGPT Codex backend
//     (chatgpt.com/backend-api/codex/responses). Credentials and the
//     chatgpt-account-id ride through differently: the access token is
//     injected by the harness via the bearer sentinel, while the account id
//     and session id travel in `source.defaults.providerOptions`. Continuity
//     is not Responses store chaining: the backend requires `store: false`
//     (`store: true` → 400) and rejects `previous_response_id`. Every turn
//     resends the full `input`; encrypted reasoning captured from the prior
//     stream is resent as a `reasoning` item.
//   - grok-responses: the grok-cli OAuth proxy (cli-chat-proxy.grok.com). The
//     request shape mirrors the grok CLI's own /v1/responses call (captured
//     live): the system prompt rides as a leading `system` input message
//     (string content, not parts), reasoning is requested by summary, and the
//     caller is identified by x-grok-* headers rather than a body field.
//   - openai-responses: generic OpenAI Responses endpoints, used by OpenCode Go
//     models that speak Responses rather than Chat Completions (e.g.
//     gpt-5.6-luna).
// All three share the same SSE parser and one request mapper parameterized by
// a per-backend spec (endpoint, headers, reasoning/sampling configuration, and
// the two wire conventions for message content — see ResponsesMessageShape).

export const CODEX_RESPONSES_PROVIDER = "codex-responses";
export const GROK_RESPONSES_PROVIDER = "grok-responses";
export const OPENAI_RESPONSES_PROVIDER = "openai-responses";

// Keys the sources stash in defaults.providerOptions for these adapters.
export const CODEX_ACCOUNT_ID_OPTION = "codexAccountId";
export const CODEX_SESSION_ID_OPTION = "codexSessionId";
export const GROK_USER_ID_OPTION = "grokUserId";
export const GROK_SESSION_ID_OPTION = "grokSessionId";
export const OPENAI_SESSION_ID_OPTION = "openaiSessionId";
export const OPENCODE_SESSION_ID_OPTION = "opencodeSessionId";

// Wire-charset limit for function names on the Responses surface (Codex,
// Grok, and the generic OpenAI Responses adapter all share OpenAI's
// `^[a-zA-Z0-9_-]{1,64}$` function-name charset).
export const RESPONSES_TOOL_NAME_LIMIT: ToolNameLimit = {
  provider: "responses",
  maxLength: 64,
};

// ---------------------------------------------------------------------------
// Fetch boundary: Codex Content-Type repair
// ---------------------------------------------------------------------------

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
// Reasoning-signature tagging (multi-turn continuity)
// ---------------------------------------------------------------------------

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
      content: string | ResponsesContentPart[];
    }
  | { type: "function_call"; name: string; arguments: string; call_id: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; summary: never[]; encrypted_content: string };

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

export function optionString(options: InferenceOptions, key: string): string | undefined {
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

// The two wire conventions for message content across the Responses backends:
//   - "codex": content is always an array of parts, and assistant text uses
//     `output_text` parts (the ChatGPT backend's shape).
//   - "grok": text-only messages serialize content as a plain string (the
//     shape the grok proxy emits); text is always `input_text`.
type ResponsesMessageShape = "codex" | "grok";

// Map one internal turn to zero or more Responses items. Assistant text uses
// `output_text` parts on the codex shape and `input_text` everywhere else;
// the grok shape keeps text-only messages as a string. Tool calls become
// `function_call` items (arguments serialized to a JSON string) and tool
// results become `function_call_output` items. Reasoning blocks are echoed
// back only when they carry the opaque `encrypted_content` the backend issued
// (held in a thinking block's signature) AND that backend is the one this
// request is going to — replaying it to a different provider gets a 400 it
// cannot recover from.
function toResponsesItems(
  turn: ConversationTurn,
  requestModel: string,
  requestProvider: string,
  shape: ResponsesMessageShape,
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  const role = turn.role;
  const parts: ResponsesContentPart[] = [];
  // The grok shape flattens text-only messages to a string; a message with
  // image blocks switches to content parts so the model receives the actual
  // pixels instead of only a text placeholder.
  let hasImage = false;
  // Codex's ChatGPT backend distinguishes assistant output_text from input_text;
  // the grok shape uses input_text for every role.
  const textKind: "input_text" | "output_text" =
    shape === "codex" && role === "assistant" ? "output_text" : "input_text";
  // A reasoning block whose signature we could not replay (foreign provider,
  // model switch, or a missing/untagged signature) leaves any function_call
  // it produced without the reasoning item the Responses API expects to
  // precede it — the exact orphaned shape that degenerates reasoning models.
  // Suppress function_call items until the next text or successfully-replayed
  // reasoning item re-establishes a clean turn shape; tool results are
  // unaffected since they never need a preceding reasoning item.
  let suppressOrphanedCalls = false;

  const flushMessage = (): void => {
    if (parts.length === 0) return;
    items.push({
      type: "message",
      role,
      content:
        shape === "grok" && !hasImage
          ? parts.map((part) => (part.type === "input_text" ? part.text : "")).join("")
          : [...parts],
    });
    parts.length = 0;
    hasImage = false;
    suppressOrphanedCalls = false;
  };

  for (const block of turn.content) {
    if (block.type === "text") {
      parts.push({ type: textKind, text: block.text } as ResponsesContentPart);
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
          type: textKind,
          text: `[Unsupported image reference omitted: ${block.source.reference}]`,
        } as ResponsesContentPart);
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

// Everything that differs between the Responses backends this module adapts.
interface ResponsesRequestSpec {
  /** Endpoint path for the Responses API. */
  url: string;
  /** providerOptions key carrying the inference thread's session id. */
  sessionIdOptionKey: string;
  /**
   * Reasoning summary mode. "detailed" streams denser summary deltas than
   * "auto": Grok bills full thinking tokens but only returns summarized text;
   * sparse auto summaries left the stall/activity clocks quiet for 60–120s
   * mid-think. Absent for Codex: the ChatGPT backend rejects summary values
   * for the gpt-5.6-terra / gpt-5.3-codex family (HTTP 400; supported:
   * concise | detailed | none) and the Codex CLI catalog default is none, so
   * Codex request bodies send effort only (CL-6893).
   */
  reasoningSummary?: "auto" | "detailed";
  /** Extract the reasoning.effort value from options, or undefined to omit it. */
  effort: (options: InferenceOptions) => string | undefined;
  /** Forward maxTokens/temperature into the request body. */
  forwardSamplingParams: boolean;
  /** Codex sends the explicit `parallel_tool_calls: false` (backend rejects true). */
  parallelToolCalls: boolean;
  /**
   * Where the system prompt rides: Codex carries it in the `instructions`
   * body field; the grok shape prepends a leading system input message.
   */
  systemPromptIn: "instructions" | "input";
  /** Keep only the last duplicate tool item; Codex keeps every item verbatim. */
  dedupeToolItems: boolean;
  /** Which message-content wire convention to emit. */
  messageShape: ResponsesMessageShape;
  /** Provider-specific headers on top of the base content-type/accept/auth set. */
  extraHeaders: (options: InferenceOptions, model: string) => Record<string, string>;
}

function buildResponsesRequest(
  messages: ConversationTurn[],
  model: string,
  options: InferenceOptions,
  requestProvider: string,
  spec: ResponsesRequestSpec,
): BuiltRequest {
  const mapped = messages.flatMap((turn) =>
    toResponsesItems(turn, model, requestProvider, spec.messageShape),
  );
  const conversation = spec.dedupeToolItems ? dedupeToolItems(mapped) : mapped;
  const systemMessage: ResponsesInputItem | undefined =
    spec.systemPromptIn === "input" && options.systemPrompt !== undefined
      ? { type: "message", role: "system", content: options.systemPrompt }
      : undefined;
  const input = systemMessage !== undefined ? [systemMessage, ...conversation] : conversation;
  const tools = toResponsesTools(options);

  const body: Record<string, unknown> = {
    model,
    input,
    // Every backend requires `store: false` (Codex: store:true → 400) and
    // rejects `previous_response_id`. Multi-turn continuity is full input plus
    // encrypted reasoning round-trip only — do not attempt response-id
    // chaining on this surface.
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
  };
  if (spec.parallelToolCalls) {
    // Serial at the request layer. The reactor already executes a multi-call
    // batch concurrently; this flag is what the ChatGPT Codex backend is sent.
    // Do not flip without verifying the backend accepts true — unlike store /
    // previous_response_id there is no recorded 400.
    body["parallel_tool_calls"] = false;
  }
  if (spec.systemPromptIn === "instructions" && options.systemPrompt !== undefined) {
    // The Codex backend rejects `max_output_tokens`; it is intentionally
    // omitted. `instructions` is exactly the supplied system prompt
    // (including an empty string), omitted when unset.
    body["instructions"] = options.systemPrompt;
  }
  const reasoning: Record<string, unknown> = {};
  if (spec.reasoningSummary !== undefined) reasoning["summary"] = spec.reasoningSummary;
  // reasoning_effort rides in providerOptions (same place the OpenAI-compatible
  // path reads it); the adapter does not invent a default.
  const effort = spec.effort(options);
  if (effort !== undefined) reasoning["effort"] = effort;
  if (Object.keys(reasoning).length > 0) body["reasoning"] = reasoning;
  if (tools !== undefined) {
    body["tools"] = tools;
    body["tool_choice"] = "auto";
  }
  if (spec.forwardSamplingParams) {
    if (options.maxTokens !== undefined) body["max_output_tokens"] = options.maxTokens;
    if (options.temperature !== undefined) body["temperature"] = options.temperature;
  }
  // With store:false this is the only cache-routing signal; keying it to the
  // inference thread's session id keeps every request on the same cache shard.
  const sessionId = optionString(options, spec.sessionIdOptionKey);
  if (sessionId !== undefined) body["prompt_cache_key"] = sessionId;

  return {
    url: spec.url,
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: BEARER_CREDENTIAL_SENTINEL,
      ...spec.extraHeaders(options, model),
    },
    body: JSON.stringify(body),
  };
}

// The Codex backend identifies the caller by the bearer token plus the
// chatgpt-account-id header; the account id rides in providerOptions because
// the harness injects the token separately.
const CODEX_SPEC: ResponsesRequestSpec = {
  url: CODEX_RESPONSES_PATH,
  sessionIdOptionKey: CODEX_SESSION_ID_OPTION,
  // CL-6893: no summary for the ChatGPT backend (see the field doc).
  effort: (options) => {
    // "none" is the Codex CLI catalog default for reasoning_effort — sending
    // it is a no-op at best; skip it.
    const value = options.providerOptions?.["reasoning_effort"];
    return typeof value === "string" && value !== "none" ? value : undefined;
  },
  forwardSamplingParams: false,
  parallelToolCalls: true,
  systemPromptIn: "instructions",
  dedupeToolItems: false,
  messageShape: "codex",
  extraHeaders: (options) => {
    const headers: Record<string, string> = {
      "openai-beta": "responses=experimental",
      originator: CODEX_AUTHORIZE_EXTRA_PARAMS["originator"] ?? "codex_cli_rs",
    };
    const accountId = optionString(options, CODEX_ACCOUNT_ID_OPTION);
    if (accountId !== undefined) headers["chatgpt-account-id"] = accountId;
    const sessionId = optionString(options, CODEX_SESSION_ID_OPTION);
    if (sessionId !== undefined) headers["session_id"] = sessionId;
    return headers;
  },
};

// The grok proxy identifies the caller by client headers in addition to the
// bearer token; values mirror the grok CLI's own /v1/responses call.
const GROK_SPEC: ResponsesRequestSpec = {
  url: XAI_RESPONSES_PATH,
  sessionIdOptionKey: GROK_SESSION_ID_OPTION,
  reasoningSummary: "detailed",
  effort: (options) => optionString(options, "reasoning_effort"),
  forwardSamplingParams: false,
  parallelToolCalls: false,
  systemPromptIn: "input",
  dedupeToolItems: true,
  messageShape: "grok",
  extraHeaders: (options, model) => {
    const headers: Record<string, string> = {
      "user-agent": XAI_USER_AGENT,
      "x-grok-client-identifier": XAI_CLIENT_IDENTIFIER,
      "x-grok-client-version": XAI_CLIENT_VERSION,
      "x-grok-model-override": model,
    };
    const userId = optionString(options, GROK_USER_ID_OPTION);
    if (userId !== undefined) headers["x-grok-user-id"] = userId;
    return headers;
  },
};

const OPENAI_SPEC: ResponsesRequestSpec = {
  url: "/responses",
  sessionIdOptionKey: OPENAI_SESSION_ID_OPTION,
  reasoningSummary: "auto",
  effort: (options) => optionString(options, "reasoning_effort"),
  forwardSamplingParams: true,
  parallelToolCalls: false,
  systemPromptIn: "input",
  dedupeToolItems: true,
  messageShape: "grok",
  extraHeaders: (options) => {
    const opencodeSessionId = optionString(options, OPENCODE_SESSION_ID_OPTION);
    return opencodeSessionId !== undefined ? { "x-opencode-session": opencodeSessionId } : {};
  },
};

export function createCodexResponsesAdapter(source: LastCycleSource): ProviderAdapter {
  // Re-created per request in buildRequest — see parseResponse below.
  let indexer = createResponsesBlockIndexer();
  return {
    buildRequest: (messages, model, options) => {
      indexer = createResponsesBlockIndexer();
      return buildResponsesRequest(messages, model, options, source.provider, CODEX_SPEC);
    },
    parseResponse: (sseData) => parseResponse(sseData, indexer, source),
    parseJSONResponse,
    isStreamTerminal: isResponsesStreamTerminal,
  };
}

export function createGrokResponsesAdapter(source: LastCycleSource): ProviderAdapter {
  // Re-created per request in buildRequest — see parseResponse below.
  let indexer = createResponsesBlockIndexer();
  return {
    buildRequest: (messages, model, options) => {
      indexer = createResponsesBlockIndexer();
      return buildResponsesRequest(messages, model, options, source.provider, GROK_SPEC);
    },
    parseResponse: (sseData) => parseResponse(sseData, indexer, source, GROK_RESPONSES_PROVIDER),
    parseJSONResponse,
  };
}

export function createOpenAIResponsesAdapter(source: LastCycleSource): ProviderAdapter {
  // Re-created per request in buildRequest — see parseResponse below.
  let indexer = createResponsesBlockIndexer();
  return {
    buildRequest: (messages, model, options) => {
      indexer = createResponsesBlockIndexer();
      return buildResponsesRequest(messages, model, options, source.provider, OPENAI_SPEC);
    },
    parseResponse: (sseData) => parseResponse(sseData, indexer, source, OPENAI_RESPONSES_PROVIDER),
    parseJSONResponse,
    isStreamTerminal: isResponsesStreamTerminal,
  };
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

// All three backends speak the same Responses SSE protocol, so the parser is
// shared. Each adapter creates its own indexer per request.
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

const EMPTY_PARTIAL: PartialMessage = { text: "" };

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
// (buildResponsesRequest sets it unconditionally), so a non-streaming JSON
// body reaching the harness means the response kind was misdetected or the
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
