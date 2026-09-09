// Codex (ChatGPT subscription) OAuth provider stack: PKCE login, named-profile
// storage, and transparent token refresh. The whole stack (store, session,
// oauth helpers, callback server, login) is built by the shared factory in
// auth/oauth/provider.ts; this module owns the provider config only. Profiles
// are keyed by user-chosen name so multiple Codex subscriptions can coexist.

import {
  baseTokensFromResponse,
  type OAuthClientConfig,
  type TokenResponse,
} from "../oauth/client.js";
import { createProviderAuth, type ProviderAuthConfig } from "../oauth/provider.js";
import type { BaseTokens } from "../oauth/store.js";
import {
  CODEX_AUTHORIZE_EXTRA_PARAMS,
  CODEX_AUTHORIZE_URL,
  CODEX_CALLBACK_PATH,
  CODEX_CALLBACK_PORT,
  CODEX_CLIENT_ID,
  CODEX_REDIRECT_URI,
  CODEX_REFRESH_SKEW_MS,
  CODEX_SCOPES,
  CODEX_TOKEN_TIMEOUT_MS,
  CODEX_TOKEN_URL,
} from "./constants.js";

export type CodexTokens = BaseTokens & {
  // ChatGPT account id extracted from the id_token, required as the
  // `chatgpt-account-id` header on every Codex inference request.
  accountId?: string;
};

export interface CodexAccess {
  access: string;
  accountId?: string | undefined;
}

export const codexOAuthConfig: OAuthClientConfig = {
  clientId: CODEX_CLIENT_ID,
  authorizeUrl: CODEX_AUTHORIZE_URL,
  tokenUrl: CODEX_TOKEN_URL,
  redirectUri: CODEX_REDIRECT_URI,
  scopes: CODEX_SCOPES,
  extraAuthorizeParams: CODEX_AUTHORIZE_EXTRA_PARAMS,
  tokenTimeoutMs: CODEX_TOKEN_TIMEOUT_MS,
  label: "Codex",
};

function isCodexTokens(value: unknown): value is CodexTokens {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.access === "string" &&
    typeof t.refresh === "string" &&
    typeof t.expiresAt === "number" &&
    (t.accountId === undefined || typeof t.accountId === "string")
  );
}

// Decode the ChatGPT account id from an id_token (a JWT). The claim lives at
// `chatgpt_account_id` or nested under the `https://api.openai.com/auth` claim.
// Only the payload segment is read; the signature is not verified here because
// the token came straight from the authorization server over TLS and is used
// solely to label the account, not to authorize anything.
export function accountIdFromIdToken(idToken: string | undefined): string | undefined {
  if (idToken === undefined) return undefined;
  const payload = idToken.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const claims = JSON.parse(json) as Record<string, unknown>;
    const direct = claims["chatgpt_account_id"];
    if (typeof direct === "string") return direct;
    const nested = claims["https://api.openai.com/auth"];
    if (typeof nested === "object" && nested !== null) {
      const id = (nested as Record<string, unknown>)["chatgpt_account_id"];
      if (typeof id === "string") return id;
    }
  } catch {
    // A malformed id_token just means no account id; the caller may still
    // function for flows that do not require the header.
  }
  return undefined;
}

const codexConfig: ProviderAuthConfig<CodexTokens, CodexAccess> = {
  errorName: "CodexAuthError",
  label: "Codex",
  filename: "codex-auth.json",
  oauth: codexOAuthConfig,
  callback: {
    port: CODEX_CALLBACK_PORT,
    path: CODEX_CALLBACK_PATH,
    // Codex's registered redirect_uri uses localhost (not 127.0.0.1).
    publicHost: "localhost",
  },
  isTokens: isCodexTokens,
  tokensFromResponse: (response: TokenResponse, now: number, previousRefresh?: string) => {
    const base = baseTokensFromResponse(response, now, previousRefresh, "Codex");
    const accountId = accountIdFromIdToken(response.id_token);
    return {
      ...base,
      ...(accountId !== undefined ? { accountId } : {}),
    };
  },
  refreshSkewMs: CODEX_REFRESH_SKEW_MS,
  // A usable access token plus the account id that must ride alongside it in
  // the chatgpt-account-id header. Returned together so callers need a single
  // load, not a token fetch followed by a separate profile read (which could
  // observe a token and account id from two different points in a concurrent
  // refresh).
  toAccess: (tokens) => ({ access: tokens.access, accountId: tokens.accountId }),
  // The refresh response rarely re-issues an id_token, so carry the account id
  // forward from the prior tokens when the refresh did not supply one.
  mergeRefreshed: (refreshed, previous) =>
    refreshed.accountId === undefined && previous.accountId !== undefined
      ? { ...refreshed, accountId: previous.accountId }
      : refreshed,
  missingError: (name) => `Codex profile "${name}" is not authorized. Log in again.`,
  refreshFailedError: (name, err) =>
    `Codex profile "${name}" could not be refreshed (${err instanceof Error ? err.message : String(err)}). Log in again.`,
};

export const codexAuth = createProviderAuth<CodexTokens, CodexAccess>(codexConfig);
