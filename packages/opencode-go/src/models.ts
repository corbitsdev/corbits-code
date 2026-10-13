// Offline/failure fallback plus per-model protocol metadata.
// Selectable ids come from live GET /zen/go/v1/models in the host; this
// packaged list is used when that fetch has not succeeded. Protocol
// routing stays here. Live ids absent from PROTOCOL_BY_ID use Chat Completions.
// MiniMax and Qwen3.8 Max are messages on Go, unlike Zen chat-completions.

export type GoProtocol = "chat-completions" | "responses" | "messages";

interface GoModel {
  id: string;
  name: string;
  protocol: GoProtocol;
}

export const OPENCODE_GO_MODELS = [
  { id: "grok-4.7", name: "Grok 4.7", protocol: "responses" },
  { id: "grok-4.6", name: "Grok 4.6", protocol: "responses" },
  { id: "grok-4.5", name: "Grok 4.5", protocol: "responses" },
  { id: "gpt-6-luna", name: "GPT 6 Luna", protocol: "responses" },
  { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", protocol: "responses" },
  {
    id: "muse-spark-1.3-contributor",
    name: "Muse Spark 1.3 Contributor",
    protocol: "responses",
  },
  {
    id: "muse-spark-1.2-contributor",
    name: "Muse Spark 1.2 Contributor",
    protocol: "responses",
  },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", protocol: "messages" },
  { id: "minimax-m3", name: "MiniMax M3", protocol: "messages" },
  { id: "minimax-m2.7", name: "MiniMax M2.7", protocol: "messages" },
  { id: "minimax-m2.5", name: "MiniMax M2.5", protocol: "messages" },
  { id: "qwen3.8-max", name: "Qwen3.8 Max", protocol: "messages" },
  { id: "qwen3.8-flash", name: "Qwen3.8 Flash", protocol: "messages" },
  { id: "qwen3.7-max", name: "Qwen3.7 Max", protocol: "messages" },
  { id: "qwen3.7-plus", name: "Qwen3.7 Plus", protocol: "messages" },
  { id: "qwen3.6-plus", name: "Qwen3.6 Plus", protocol: "messages" },
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", protocol: "chat-completions" },
  { id: "glm-5.3", name: "GLM-5.3", protocol: "chat-completions" },
  { id: "glm-5.2", name: "GLM-5.2", protocol: "chat-completions" },
  { id: "glm-5.1", name: "GLM-5.1", protocol: "chat-completions" },
  { id: "kimi-k3", name: "Kimi K3", protocol: "chat-completions" },
  {
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    protocol: "chat-completions",
  },
  { id: "kimi-k2.6", name: "Kimi K2.6", protocol: "chat-completions" },
  { id: "longcat-2.0", name: "LongCat-2.0", protocol: "chat-completions" },
  {
    id: "longcat-2.5-preview-free",
    name: "LongCat 2.5 Preview Free",
    protocol: "chat-completions",
  },
  {
    id: "step-5-preview-free",
    name: "Step 5 Preview Free",
    protocol: "chat-completions",
  },
  {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    protocol: "chat-completions",
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    protocol: "chat-completions",
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    protocol: "chat-completions",
  },
  {
    id: "deepseek-v4-flash-vision-exp",
    name: "DeepSeek V4 Flash Vision Exp",
    protocol: "chat-completions",
  },
  {
    id: "mimo-v2.6-flash",
    name: "MiMo-V2.6-Flash",
    protocol: "chat-completions",
  },
  { id: "mimo-v2.6-pro", name: "MiMo-V2.6-Pro", protocol: "chat-completions" },
  { id: "mimo-v2.5", name: "MiMo-V2.5", protocol: "chat-completions" },
  { id: "mimo-v2.5-pro", name: "MiMo-V2.5-Pro", protocol: "chat-completions" },
  { id: "hy4-preview", name: "Hy4 Preview", protocol: "chat-completions" },
  { id: "hy3", name: "Hy3", protocol: "chat-completions" },
  { id: "space-bunny", name: "Space Bunny", protocol: "chat-completions" },
] as const satisfies readonly GoModel[];

export type GoModelId = (typeof OPENCODE_GO_MODELS)[number]["id"];

export const OPENCODE_GO_MODEL_IDS: readonly string[] = OPENCODE_GO_MODELS.map(
  (m) => m.id,
);

export const OPENCODE_GO_DEFAULT_MODEL: GoModelId = "kimi-k2.7-code";

export const PROTOCOL_BY_ID: ReadonlyMap<string, GoProtocol> = new Map<
  string,
  GoProtocol
>(OPENCODE_GO_MODELS.map((m) => [m.id, m.protocol]));

export function protocolForGoModel(modelId: string): GoProtocol | undefined {
  return PROTOCOL_BY_ID.get(modelId);
}

/** True when `modelId` has a local protocol-map entry, not whether it is in the live picker. */
export function isKnownGoModel(modelId: string): boolean {
  return PROTOCOL_BY_ID.has(modelId);
}
