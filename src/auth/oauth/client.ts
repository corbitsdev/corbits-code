import { type } from "arktype";

import type { Pkce } from "./pkce.js";
import type { BaseTokens } from "./store.js";

// Provider-agnostic OAuth client config. Endpoints, client id, scopes, and
// timeouts stay provider-owned; this module owns the shared request shape.
export interface OAuthClientConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scopes: readonly string[];
  // Extra authorize-request params a provider requires (e.g. Codex simplified flow).
  extraAuthorizeParams?: Record<string, string>;
  tokenTimeoutMs: number;
  // Product label used in error messages ("Codex", "xAI", …).
  label: string;
}

// Build the authorization URL the user opens to grant access. The challenge
// binds this request to the PKCE verifier held locally; `state` is the CSRF
// nonce the redirect must echo back unchanged.
export function buildAuthorizeUrl(config: OAuthClientConfig, pkce: Pkce, state: string): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", pkce.method);
  url.searchParams.set("state", state);
  if (config.extraAuthorizeParams !== undefined) {
    for (const [key, value] of Object.entries(config.extraAuthorizeParams)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

// Validate the whole token response, not just access_token: a malformed
// expires_in (e.g. the string "soon") would otherwise survive and compute a NaN
// expiry, which never compares as expired, so the token would never refresh.
export const TokenResponseSchema = type({
  access_token: "string",
  "refresh_token?": "string",
  "expires_in?": "number",
  "id_token?": "string",
});
export type TokenResponse = typeof TokenResponseSchema.infer;

export class OAuthTokenEndpointError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(label: string, status: number, detail: string) {
    super(`${label} token endpoint returned ${String(status)}${detail ? `: ${detail}` : ""}`);
    this.name = "OAuthTokenEndpointError";
    this.status = status;
    this.detail = detail;
  }
}

// Default access-token lifetime when the server omits expires_in. Conservative
// so the refresh path engages sooner rather than trusting a stale token.
const DEFAULT_EXPIRES_IN_S = 3600;

// Convert a token response to the shared base token fields. `now` is injectable
// so callers (and tests) control the expiry baseline; `previousRefresh` is
// carried forward when a refresh response omits a new refresh_token (servers may
// rotate or not).
export function baseTokensFromResponse(
  response: TokenResponse,
  now: number,
  previousRefresh: string | undefined,
  label: string,
): BaseTokens {
  const expiresInMs = (response.expires_in ?? DEFAULT_EXPIRES_IN_S) * 1000;
  const refresh = response.refresh_token ?? previousRefresh;
  if (refresh === undefined) {
    throw new Error(
      `${label} token response carried no refresh_token and none was previously stored.`,
    );
  }
  return {
    access: response.access_token,
    refresh,
    expiresAt: now + expiresInMs,
  };
}

export async function postToken(
  config: OAuthClientConfig,
  body: URLSearchParams,
): Promise<TokenResponse> {
  // Refresh runs on the send path before inference, outside the harness timers,
  // so the token request must abort within the bounded timeout rather than hang
  // the agent forever when the endpoint stalls.
  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    signal: AbortSignal.timeout(config.tokenTimeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new OAuthTokenEndpointError(config.label, res.status, detail);
  }
  // AbortSignal.timeout throws a DOMException (name "TimeoutError") when it
  // fires; its message ("The operation timed out") is what callers report.
  const json = TokenResponseSchema(await res.json());
  if (json instanceof type.errors) {
    throw new Error(
      `${config.label} token endpoint returned an unexpected payload: ${json.summary}`,
    );
  }
  return json;
}

// Exchange an authorization code for a raw token response. Providers map the
// response onto their stored token shape (account id, id_token, …).
export async function exchangeCode(
  config: OAuthClientConfig,
  code: string,
  verifier: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });
  return postToken(config, body);
}

// Mint a fresh access token from a refresh token. Returns the raw response;
// providers map it and carry the prior refresh token forward when omitted.
export async function refreshTokenRequest(
  config: OAuthClientConfig,
  refreshToken: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
  });
  return postToken(config, body);
}
