import { XAI_REDIRECT_URI } from "@corbits/xai-provider";

export {
  XAI_DEFAULT_MODELS,
  XAI_OAUTH_PROXY_BASE_URL as XAI_BASE_URL,
  XAI_REDIRECT_URI,
  XAI_REFRESH_SKEW_MS,
} from "@corbits/xai-provider";

const xaiRedirect = new URL(XAI_REDIRECT_URI);
export const XAI_CALLBACK_PORT = Number(xaiRedirect.port);
export const XAI_CALLBACK_PATH = xaiRedirect.pathname;

// The CLI chat proxy speaks the OpenAI Responses API and authenticates the
// caller by client headers in addition to the bearer token. Values mirror the
// grok CLI's own request (captured live). Do not replace these with a product
// user-agent — the proxy and billing surfaces expect the grok-shell identity.
export const XAI_CLIENT_IDENTIFIER = "grok-shell";
export const XAI_CLIENT_VERSION = "0.2.93";
export const XAI_USER_AGENT = "grok-shell/0.2.93 (macos; aarch64)";

export const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";

// Cap every token and billing request to the xAI proxy. The refresh runs on the
// send path before the inference fetch arms its inactivity/total timers, so a
// stalled token endpoint would otherwise freeze the agent at turn 0.
export const XAI_TOKEN_TIMEOUT_MS = 15_000;
