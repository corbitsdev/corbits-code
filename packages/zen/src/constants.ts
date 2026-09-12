// OpenCode Zen pay-as-you-go endpoints.
// Docs: https://opencode.ai/docs/zen/
// Auth: API key from https://opencode.ai/auth topped up with Zen credits.

export const ZEN_PROVIDER_ID = "zen";
export const ZEN_DISPLAY_NAME = "OpenCode Zen";

// OpenAI-compatible surface (chat completions + responses). Paths are relative
// to this base: /chat/completions, /responses, /models.
export const ZEN_DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";

// Anthropic Messages adapter appends `/v1/messages`, so the root (without /v1)
// is the correct base for message-protocol models.
export const ZEN_BASE_URL = "https://opencode.ai/zen";

export const ZEN_MODELS_PATH = "/models";

export const ZEN_AUTH_HINT =
  "OpenCode Zen pay-as-you-go credits — paste your API key from https://opencode.ai/auth";
