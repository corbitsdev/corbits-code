// Offline/failure fallback plus per-model protocol metadata.
// Selectable ids come from live GET /zen/go/v1/models in the host; this
// packaged list is used when that fetch has not succeeded. Protocol
// routing stays here. Live ids absent from PROTOCOL_BY_ID use Chat Completions.

export type GoProtocol = "chat-completions" | "responses" | "messages";

export interface GoModel {
  id: string;
  name: string;
  protocol: GoProtocol;
}

export const OPENCODE_GO_MODELS = [
  { id: "grok-4.5", name: "Grok 4.5", protocol: "chat-completions" },
  { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", protocol: "responses" },
  { id: "glm-5.2", name: "GLM-5.2", protocol: "chat-completions" },
  { id: "glm-5.1", name: "GLM-5.1", protocol: "chat-completions" },
  { id: "kimi-k3", name: "Kimi K3", protocol: "chat-completions" },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", protocol: "chat-completions" },
  { id: "kimi-k2.6", name: "Kimi K2.6", protocol: "chat-completions" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", protocol: "chat-completions" },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", protocol: "chat-completions" },
  { id: "mimo-v2.5", name: "MiMo-V2.5", protocol: "chat-completions" },
  { id: "mimo-v2.5-pro", name: "MiMo-V2.5-Pro", protocol: "chat-completions" },
  { id: "minimax-m3", name: "MiniMax M3", protocol: "messages" },
  { id: "minimax-m2.7", name: "MiniMax M2.7", protocol: "messages" },
  { id: "minimax-m2.5", name: "MiniMax M2.5", protocol: "messages" },
  { id: "qwen3.8-max", name: "Qwen3.8 Max", protocol: "messages" },
  { id: "qwen3.7-max", name: "Qwen3.7 Max", protocol: "messages" },
  { id: "qwen3.7-plus", name: "Qwen3.7 Plus", protocol: "messages" },
  { id: "qwen3.6-plus", name: "Qwen3.6 Plus", protocol: "messages" },
  { id: "hy3", name: "Hy3", protocol: "chat-completions" },
] as const satisfies readonly GoModel[];

export type GoModelId = (typeof OPENCODE_GO_MODELS)[number]["id"];

export const OPENCODE_GO_MODEL_IDS: readonly string[] = OPENCODE_GO_MODELS.map((m) => m.id);

export const OPENCODE_GO_DEFAULT_MODEL: GoModelId = "kimi-k2.7-code";

const PROTOCOL_BY_ID = new Map<string, GoProtocol>(
  OPENCODE_GO_MODELS.map((m) => [m.id, m.protocol]),
);

export function protocolForGoModel(modelId: string): GoProtocol | undefined {
  return PROTOCOL_BY_ID.get(modelId);
}

/** True when `modelId` has a local protocol-map entry, not whether it is in the live picker. */
export function isKnownGoModel(modelId: string): boolean {
  return PROTOCOL_BY_ID.has(modelId);
}
