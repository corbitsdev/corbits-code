import {
  type BuiltRequest,
  type ProviderAdapter,
} from "@intx/inference";
import { createOpenAIAdapter } from "@intx/inference/providers";

// The stock OpenAI adapter builds the request body from a fixed set of fields
// (max_tokens, temperature, tools, messages, response_format) and ignores
// `options.providerOptions` — so provider-native knobs carried there, such as
// OpenAI's `reasoning_effort`, never reach the wire. The Google adapter merges
// providerOptions into its body; the OpenAI one does not.
//
// Rather than fork the ~700-line adapter or patch the interchange submodule,
// this wraps the real adapter and post-processes only the request body: it
// delegates streaming, retry, and pacing untouched, and shallow-merges
// providerOptions into the already-built body (the same contract the Google
// adapter honors). Registering it under "openai-compatible" replaces the stock
// adapter for every source intercode builds.
type AdapterSource = Parameters<typeof createOpenAIAdapter>[0];

export function createOpenAICompatibleAdapter(source: AdapterSource): ProviderAdapter {
  const base = createOpenAIAdapter(source);

  const ensureAccept = (req: BuiltRequest): BuiltRequest => {
    const has = req.headers.Accept || req.headers.accept;
    if (has) return req;
    return {
      ...req,
      headers: { ...req.headers, Accept: "text/event-stream" },
    };
  };

  const buildRequest: ProviderAdapter["buildRequest"] = (messages, model, options) => {
    // Strip assistant turns with no text or tool_call content (e.g. a turn that
    // produced only thinking blocks). transform.ts should handle this but misses
    // the case where filteredContent is non-empty; the API rejects such turns
    // with HTTP 400. Fast-path: only allocate when a bad turn is actually found.
    const needsSanitize = messages.some(
      (msg) => msg.role === "assistant" && !msg.content.some((b) => b.type === "text" || b.type === "tool_call"),
    );
    const sanitized = needsSanitize
      ? messages.filter((msg) => msg.role !== "assistant" || msg.content.some((b) => b.type === "text" || b.type === "tool_call"))
      : messages;
    const built = base.buildRequest(sanitized, model, options);
    const providerOptions = options.providerOptions;
    const hasProviderOptions = providerOptions !== undefined && Object.keys(providerOptions).length > 0;
    // DeepSeek returns HTTP 400 if `reasoning_content` appears in input messages,
    // whereas the base adapter emits it for any model with thinking enabled.
    const stripReasoning = model.toLowerCase().includes("deepseek");
    if (!hasProviderOptions && !stripReasoning) return ensureAccept(built);

    const body = JSON.parse(built.body) as Record<string, unknown>;
    if (hasProviderOptions) Object.assign(body, providerOptions);
    if (stripReasoning && Array.isArray(body["messages"])) {
      for (const msg of body["messages"]) {
        if (msg !== null && typeof msg === "object") delete (msg as Record<string, unknown>)["reasoning_content"];
      }
    }
    const merged: BuiltRequest = { ...built, body: JSON.stringify(body) };
    return ensureAccept(merged);
  };

  // DeepSeek via NVIDIA NIM sends null for delta fields the upstream schema
  // requires to be non-null (role: string, tool_calls: array). Fields that
  // legitimately accept null (content, reasoning_content, etc.) are left alone.
  const NULL_REJECTED_DELTA_FIELDS = new Set(["role", "tool_calls"]);
  const parseResponse: ProviderAdapter["parseResponse"] = (sseData: string) => {
    let data = sseData;
    try {
      const parsed = JSON.parse(sseData) as Record<string, unknown>;
      const choices = parsed["choices"];
      if (Array.isArray(choices)) {
        let patched = false;
        for (const choice of choices) {
          if (choice !== null && typeof choice === "object") {
            const delta = (choice as Record<string, unknown>)["delta"];
            if (delta !== null && typeof delta === "object") {
              for (const key of NULL_REJECTED_DELTA_FIELDS) {
                if ((delta as Record<string, unknown>)[key] === null) {
                  delete (delta as Record<string, unknown>)[key];
                  patched = true;
                }
              }
            }
          }
        }
        if (patched) data = JSON.stringify(parsed);
      }
    } catch { /* not JSON — pass through */ }
    return base.parseResponse(data);
  };

  return { ...base, buildRequest, parseResponse };
}
