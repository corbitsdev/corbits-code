import {
  baseTokensFromResponse,
  buildAuthorizeUrl as buildSharedAuthorizeUrl,
  exchangeCode as exchangeSharedCode,
  refreshTokenRequest,
  type OAuthClientConfig,
  type TokenResponse,
} from "../oauth/client.js";
import type { Pkce } from "../oauth/pkce.js";
import {
  CODEX_AUTHORIZE_EXTRA_PARAMS,
  CODEX_AUTHORIZE_URL,
  CODEX_CLIENT_ID,
  CODEX_REDIRECT_URI,
  CODEX_SCOPES,
  CODEX_TOKEN_TIMEOUT_MS,
  CODEX_TOKEN_URL,
} from "./constants.js";
import type { CodexTokens } from "./store.js";

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

// Build the authorization URL the user opens to grant Codex access.
export function buildAuthorizeUrl(pkce: Pkce, state: string): string {
  return buildSharedAuthorizeUrl(codexOAuthConfig, pkce, state);
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

// Convert a token response to stored tokens. `now` is injectable so callers
// (and tests) control the expiry baseline; `previousRefresh` is carried forward
// when a refresh response omits a new refresh_token (servers may rotate or not).
export function tokensFromResponse(
  response: TokenResponse,
  now: number,
  previousRefresh?: string,
): CodexTokens {
  const base = baseTokensFromResponse(response, now, previousRefresh, "Codex");
  const accountId = accountIdFromIdToken(response.id_token);
  return {
    ...base,
    ...(accountId !== undefined ? { accountId } : {}),
  };
}

// Exchange an authorization code for tokens. `now` defaults to the current time
// but stays injectable for deterministic tests.
export async function exchangeCode(
  code: string,
  verifier: string,
  now: number,
): Promise<CodexTokens> {
  return tokensFromResponse(await exchangeSharedCode(codexOAuthConfig, code, verifier), now);
}

// Mint a fresh access token from a refresh token. Carries the prior refresh
// token forward if the server does not rotate it.
export async function refreshTokens(refreshToken: string, now: number): Promise<CodexTokens> {
  return tokensFromResponse(
    await refreshTokenRequest(codexOAuthConfig, refreshToken),
    now,
    refreshToken,
  );
}
