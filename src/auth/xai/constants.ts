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

// grok-cli OAuth tokens are NOT accepted by api.x.ai (that endpoint expects an
// API key). They authenticate against the CLI chat proxy, which exposes the
// OpenAI-compatible /v1/chat/completions surface.
export const XAI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
// The grok CLI (which our OAuth scope mirrors) exposes only two models: the
// latest coding model and Composer 2.5 Fast. Mirror that exactly — other model
// ids are rejected for grok-cli OAuth credentials.
export const XAI_DEFAULT_MODELS = [
  "grok-build",
  "grok-composer-2.5-fast",
] as const;

// The CLI chat proxy speaks the OpenAI Responses API at /v1/responses and
// authenticates the caller by client headers in addition to the bearer token.
// Values mirror the grok CLI's own /v1/responses request (captured live).
export const XAI_RESPONSES_PATH = "/responses";
export const XAI_CLIENT_IDENTIFIER = "grok-shell";
export const XAI_CLIENT_VERSION = "0.2.56";
export const XAI_USER_AGENT = "grok-shell/0.2.56 (macos; aarch64)";

// Refresh xAI access tokens 5 minutes before they expire. xAI issues ~1-hour
// tokens so a 1-hour skew makes every fresh token immediately stale.
export const XAI_REFRESH_SKEW_MS = 5 * 60 * 1000;

// Billing snapshot for prepaid plans (subscription tier + credit %). The CLI
// chat proxy mirrors the grok.com billing surface so the same OAuth token works.
export const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";

// Cap every token and billing request to the xAI proxy. The refresh runs on the
// send path before the inference fetch arms its inactivity/total timers, so a
// stalled token endpoint would otherwise freeze the agent at turn 0 (the send
// promise never settles). Aborting here surfaces a refresh failure instead.
export const XAI_TOKEN_TIMEOUT_MS = 15_000;
