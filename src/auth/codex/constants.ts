// OAuth constants for the Codex (ChatGPT Plus/Pro subscription) login flow.
// These values mirror the public Codex CLI client: the client id is a public
// identifier (not a secret), and the endpoints belong to OpenAI's consumer
// authorization server at auth.openai.com — distinct from the platform API key
// system at platform.openai.com.
//
// A successful login yields a token billed against the user's ChatGPT
// subscription. The inference base URL is chatgpt.com/backend-api, which is
// OpenAI-compatible but a different surface from api.openai.com.

// Public client identifier for the Codex CLI authorization flow. Not a secret.
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

// The Codex CLI registers a fixed loopback redirect on port 1455; the
// authorization server only accepts this exact redirect_uri for this client, so
// (unlike the MCP flow) the callback port is not free to vary.
export const CODEX_CALLBACK_PORT = 1455;
export const CODEX_CALLBACK_PATH = "/auth/callback";
export const CODEX_REDIRECT_URI = `http://localhost:${String(CODEX_CALLBACK_PORT)}${CODEX_CALLBACK_PATH}`;

export const CODEX_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

// Inference surface reached with the subscription token. NOTE: the Codex
// backend serves the OpenAI *Responses* API at `${CODEX_BASE_URL}/codex/
// responses`, not Chat Completions, and requires a `chatgpt-account-id` header
// (see CodexTokens.accountId) plus `OpenAI-Beta: responses=experimental`. The
// Responses adapter is tracked as follow-up work; this base + the stored
// accountId are the inputs it needs.
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const CODEX_RESPONSES_PATH = "/codex/responses";

// Extra authorize-request params the Codex flow requires.
export const CODEX_AUTHORIZE_EXTRA_PARAMS: Record<string, string> = {
  codex_cli_simplified_flow: "true",
  id_token_add_organizations: "true",
  originator: "codex_cli_rs",
};

// Models exposed by the Codex backend. Surfaced as the profile's model list so
// the picker has something to select; kept conservative and overridable.
export const CODEX_DEFAULT_MODELS = ["gpt-5-codex", "gpt-5"] as const;

// Refresh a token this many milliseconds before its stated expiry so a request
// is never sent with a token about to lapse mid-flight.
export const CODEX_REFRESH_SKEW_MS = 60_000;
