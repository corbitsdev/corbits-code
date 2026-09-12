// Known OpenCode Zen models and the wire protocol each one requires, from
// https://opencode.ai/docs/zen/#available-models. Zen's /models catalog is
// the live source of truth; this map only pins the protocol assignment per
// known id. Unknown ids default to chat completions (the status quo).

/** Packaged fallback seed: live discovery fallback + picker default, never empty. */
export const ZEN_MODEL_IDS: readonly string[] = [
  "gpt-6-astra",
  "gpt-5.4",
  "gpt-5.4-mini",
  "claude-fable-5-1",
  "claude-sonnet-4-5",
  "claude-opus-4-5",
  "gemini-3-flash",
  "gemini-3-pro",
];

export const ZEN_DEFAULT_MODEL = "claude-sonnet-4-5";

export type ZenProtocol = "messages" | "responses" | "chat-completions";

interface ZenModel {
  id: string;
  protocol: ZenProtocol;
}

const ZEN_MODELS: readonly ZenModel[] = [
  // Anthropic Messages API
  { id: "claude-fable-5-1", protocol: "messages" },
  { id: "claude-fable-5", protocol: "messages" },
  { id: "claude-opus-5", protocol: "messages" },
  { id: "claude-opus-4-8", protocol: "messages" },
  { id: "claude-opus-4-7", protocol: "messages" },
  { id: "claude-opus-4-6", protocol: "messages" },
  { id: "claude-opus-4-5", protocol: "messages" },
  { id: "claude-sonnet-5", protocol: "messages" },
  { id: "claude-sonnet-4-6", protocol: "messages" },
  { id: "claude-sonnet-4-5", protocol: "messages" },
  { id: "claude-haiku-4-5", protocol: "messages" },
  { id: "qwen3.7-max", protocol: "messages" },
  { id: "qwen3.7-plus", protocol: "messages" },
  { id: "qwen3.6-plus", protocol: "messages" },
  { id: "qwen3.5-plus", protocol: "messages" },
  // OpenAI Responses API
  { id: "gpt-6-astra", protocol: "responses" },
  { id: "gpt-5.6-sol", protocol: "responses" },
  { id: "gpt-5.6-terra", protocol: "responses" },
  { id: "gpt-5.6-luna", protocol: "responses" },
  { id: "gpt-5.5", protocol: "responses" },
  { id: "gpt-5.5-pro", protocol: "responses" },
  { id: "gpt-5.4", protocol: "responses" },
  { id: "gpt-5.4-pro", protocol: "responses" },
  { id: "gpt-5.4-mini", protocol: "responses" },
  { id: "gpt-5.4-nano", protocol: "responses" },
  { id: "gpt-5.3-codex", protocol: "responses" },
  { id: "gpt-5.3-codex-spark", protocol: "responses" },
  { id: "gpt-5.2", protocol: "responses" },
  { id: "gpt-5.2-codex", protocol: "responses" },
  { id: "gpt-5.1", protocol: "responses" },
  { id: "gpt-5.1-codex", protocol: "responses" },
  { id: "gpt-5.1-codex-max", protocol: "responses" },
  { id: "gpt-5.1-codex-mini", protocol: "responses" },
  { id: "gpt-5", protocol: "responses" },
  { id: "gpt-5-codex", protocol: "responses" },
  { id: "gpt-5-nano", protocol: "responses" },
  { id: "grok-4.6", protocol: "responses" },
  { id: "grok-4.5", protocol: "responses" },
  { id: "grok-build-0.1", protocol: "responses" },
  { id: "muse-spark-1.3", protocol: "responses" },
  { id: "muse-spark-1.2", protocol: "responses" },
  { id: "muse-spark-1.3-contributor-free", protocol: "responses" },
  // OpenAI Chat Completions API (explicit; unknown ids also land here)
  { id: "deepseek-v4-pro", protocol: "chat-completions" },
  { id: "deepseek-v4-flash", protocol: "chat-completions" },
  { id: "deepseek-v4-flash-vision-exp", protocol: "chat-completions" },
  { id: "minimax-m3", protocol: "chat-completions" },
  { id: "minimax-m2.7", protocol: "chat-completions" },
  { id: "minimax-m2.5", protocol: "chat-completions" },
  { id: "glm-5.3-flash", protocol: "chat-completions" },
  { id: "glm-5.3", protocol: "chat-completions" },
  { id: "glm-5.2", protocol: "chat-completions" },
  { id: "glm-5.1", protocol: "chat-completions" },
  { id: "glm-5", protocol: "chat-completions" },
  { id: "kimi-k2.5", protocol: "chat-completions" },
  { id: "kimi-k2.6", protocol: "chat-completions" },
  { id: "kimi-k2.7-code", protocol: "chat-completions" },
  { id: "kimi-k3", protocol: "chat-completions" },
  { id: "big-pickle", protocol: "chat-completions" },
  { id: "mimo-v2.5-free", protocol: "chat-completions" },
  { id: "ling-3.0-flash-fin-free", protocol: "chat-completions" },
  { id: "nemotron-3-ultra-free", protocol: "chat-completions" },
  { id: "nemotron-3.5-lightning-free", protocol: "chat-completions" },
  { id: "gemini-3-flash", protocol: "chat-completions" },
  { id: "gemini-3-pro", protocol: "chat-completions" },
];

const PROTOCOL_BY_ID = new Map<string, ZenProtocol>(
  ZEN_MODELS.map((model) => [model.id, model.protocol]),
);

/**
 * Return the wire protocol for a known Zen model id. Unknown ids default to
 * chat completions — the status quo for an unmapped model, never inferred
 * from name prefixes.
 */
export function protocolForZenModel(modelId: string): ZenProtocol {
  return PROTOCOL_BY_ID.get(modelId) ?? "chat-completions";
}

export function isKnownZenModel(modelId: string): boolean {
  return PROTOCOL_BY_ID.has(modelId);
}
