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
  XAI_AUTHORIZE_URL,
  XAI_CLIENT_ID,
  XAI_REDIRECT_URI,
  XAI_SCOPES,
  XAI_TOKEN_TIMEOUT_MS,
  XAI_TOKEN_URL,
} from "./constants.js";
import type { XaiTokens } from "./store.js";

export const xaiOAuthConfig: OAuthClientConfig = {
  clientId: XAI_CLIENT_ID,
  authorizeUrl: XAI_AUTHORIZE_URL,
  tokenUrl: XAI_TOKEN_URL,
  redirectUri: XAI_REDIRECT_URI,
  scopes: XAI_SCOPES,
  tokenTimeoutMs: XAI_TOKEN_TIMEOUT_MS,
  label: "xAI",
};

export function buildAuthorizeUrl(pkce: Pkce, state: string): string {
  return buildSharedAuthorizeUrl(xaiOAuthConfig, pkce, state);
}

export function tokensFromResponse(
  response: TokenResponse,
  now: number,
  previousRefresh?: string,
): XaiTokens {
  const base = baseTokensFromResponse(response, now, previousRefresh, "xAI");
  return {
    ...base,
    ...(response.id_token !== undefined ? { idToken: response.id_token } : {}),
  };
}

export async function exchangeCode(
  code: string,
  verifier: string,
  now: number,
): Promise<XaiTokens> {
  return tokensFromResponse(await exchangeSharedCode(xaiOAuthConfig, code, verifier), now);
}

export async function refreshTokens(refreshToken: string, now: number): Promise<XaiTokens> {
  return tokensFromResponse(
    await refreshTokenRequest(xaiOAuthConfig, refreshToken),
    now,
    refreshToken,
  );
}
