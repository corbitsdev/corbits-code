// xAI/Grok OAuth provider stack. xAI exposes an OpenAI-compatible Chat
// Completions API at api.x.ai; OAuth tokens come from auth.x.ai and are used as
// the bearer credential in the standard openai-compatible adapter. The whole
// stack (store, session, oauth helpers, callback server, login) is built by the
// shared factory in auth/oauth/provider.ts; this module owns the provider
// config only.

import {
  baseTokensFromResponse,
  type OAuthClientConfig,
  type TokenResponse,
} from "../oauth/client.js";
import { createProviderAuth, type ProviderAuthConfig } from "../oauth/provider.js";
import type { BaseTokens } from "../oauth/store.js";
import {
  XAI_AUTHORIZE_URL,
  XAI_CALLBACK_PATH,
  XAI_CALLBACK_PORT,
  XAI_CLIENT_ID,
  XAI_REDIRECT_URI,
  XAI_REFRESH_SKEW_MS,
  XAI_SCOPES,
  XAI_TOKEN_TIMEOUT_MS,
  XAI_TOKEN_URL,
} from "./constants.js";

export type XaiTokens = BaseTokens & {
  idToken?: string;
};

export interface XaiAccess {
  access: string;
}

export const xaiOAuthConfig: OAuthClientConfig = {
  clientId: XAI_CLIENT_ID,
  authorizeUrl: XAI_AUTHORIZE_URL,
  tokenUrl: XAI_TOKEN_URL,
  redirectUri: XAI_REDIRECT_URI,
  scopes: XAI_SCOPES,
  tokenTimeoutMs: XAI_TOKEN_TIMEOUT_MS,
  label: "xAI",
};

function isXaiTokens(value: unknown): value is XaiTokens {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.access === "string" &&
    typeof t.refresh === "string" &&
    typeof t.expiresAt === "number" &&
    (t.idToken === undefined || typeof t.idToken === "string")
  );
}

const xaiConfig: ProviderAuthConfig<XaiTokens, XaiAccess> = {
  errorName: "XaiAuthError",
  label: "xAI",
  filename: "xai-auth.json",
  oauth: xaiOAuthConfig,
  callback: { port: XAI_CALLBACK_PORT, path: XAI_CALLBACK_PATH },
  isTokens: isXaiTokens,
  tokensFromResponse: (response: TokenResponse, now: number, previousRefresh?: string) => {
    const base = baseTokensFromResponse(response, now, previousRefresh, "xAI");
    return {
      ...base,
      ...(response.id_token !== undefined ? { idToken: response.id_token } : {}),
    };
  },
  refreshSkewMs: XAI_REFRESH_SKEW_MS,
  toAccess: (tokens) => ({ access: tokens.access }),
  missingError: (name) => `xAI profile "${name}" is not authorized. Log in again.`,
  refreshFailedError: (name, err) =>
    `xAI profile "${name}" could not be refreshed (${err instanceof Error ? err.message : String(err)}). Log in again.`,
};

export const xaiAuth = createProviderAuth<XaiTokens, XaiAccess>(xaiConfig);
