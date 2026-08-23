// OpenCode Go subscription endpoints.
// Docs: https://opencode.ai/docs/go/
// Auth: API key from https://opencode.ai/auth after subscribing to Go.

export const OPENCODE_GO_PROVIDER_ID = "opencode-go";
export const OPENCODE_GO_DISPLAY_NAME = "OpenCode Go";

// OpenAI-compatible surface (chat completions + responses). Paths are relative
// to this base: /chat/completions, /responses, /models, /usage.
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

// Anthropic Messages adapter appends `/v1/messages`, so the root (without /v1)
// is the correct base for message-protocol models.
export const OPENCODE_GO_ANTHROPIC_BASE_URL = "https://opencode.ai/zen/go";

export const OPENCODE_GO_USAGE_PATH = "/usage";
export const OPENCODE_GO_MODELS_PATH = "/models";

export const OPENCODE_GO_AUTH_HINT = "Paste your OpenCode Go API key from https://opencode.ai/auth";
