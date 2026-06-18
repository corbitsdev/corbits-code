// OAuth constants for xAI/Grok login. xAI exposes an OpenAI-compatible Chat
// Completions API at api.x.ai; OAuth tokens come from auth.x.ai and are used as
// the bearer credential in the standard openai-compatible adapter.

export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

export const XAI_ISSUER = "https://auth.x.ai";
export const XAI_DISCOVERY_URL = `${XAI_ISSUER}/.well-known/openid-configuration`;
export const XAI_AUTHORIZE_URL = `${XAI_ISSUER}/oauth2/authorize`;
export const XAI_TOKEN_URL = `${XAI_ISSUER}/oauth2/token`;

export const XAI_CALLBACK_PORT = 1456;
export const XAI_CALLBACK_PATH = "/callback";
export const XAI_REDIRECT_URI = `http://127.0.0.1:${String(XAI_CALLBACK_PORT)}${XAI_CALLBACK_PATH}`;

export const XAI_SCOPES = ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"] as const;

export const XAI_BASE_URL = "https://api.x.ai/v1";
export const XAI_DEFAULT_MODELS = [
  "grok-build-0.1",
  "grok-4.3",
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
  "grok-4.20-multi-agent-0309",
] as const;

// xAI OAuth tokens are short-lived. Refresh early enough that long-running TUI
// sessions do not hit the expiry boundary between turns.
export const XAI_REFRESH_SKEW_MS = 60 * 60 * 1000;
