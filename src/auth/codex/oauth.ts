import {
  CODEX_AUTHORIZE_EXTRA_PARAMS,
  CODEX_AUTHORIZE_URL,
  CODEX_CLIENT_ID,
  CODEX_REDIRECT_URI,
  CODEX_SCOPES,
  CODEX_TOKEN_URL,
} from "./constants.js";
import type { Pkce } from "./pkce.js";
import type { CodexTokens } from "./store.js";

// Build the authorization URL the user opens to grant Codex access. The
// challenge binds this request to the PKCE verifier held locally; `state` is the
// CSRF nonce the redirect must echo back unchanged.
export function buildAuthorizeUrl(pkce: Pkce, state: string): string {
  const url = new URL(CODEX_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CODEX_CLIENT_ID);
  url.searchParams.set("redirect_uri", CODEX_REDIRECT_URI);
  url.searchParams.set("scope", CODEX_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", pkce.method);
  url.searchParams.set("state", state);
  for (const [key, value] of Object.entries(CODEX_AUTHORIZE_EXTRA_PARAMS)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

// The subset of OpenAI's token response we consume. `expires_in` is seconds.
type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
};

function isTokenResponse(value: unknown): value is TokenResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).access_token === "string"
  );
}

// Default access-token lifetime when the server omits expires_in. Conservative
// so the refresh path engages sooner rather than trusting a stale token.
const DEFAULT_EXPIRES_IN_S = 3600;

// Convert a token response to stored tokens. `now` is injectable so callers
// (and tests) control the expiry baseline; `previousRefresh` is carried forward
// when a refresh response omits a new refresh_token (servers may rotate or not).
export function tokensFromResponse(
  response: TokenResponse,
  now: number,
  previousRefresh?: string,
): CodexTokens {
  const expiresInMs = (response.expires_in ?? DEFAULT_EXPIRES_IN_S) * 1000;
  const refresh = response.refresh_token ?? previousRefresh;
  if (refresh === undefined) {
    throw new Error("Token response carried no refresh_token and none was previously stored.");
  }
  return {
    access: response.access_token,
    refresh,
    expiresAt: now + expiresInMs,
    ...(response.id_token !== undefined ? { idToken: response.id_token } : {}),
  };
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Codex token endpoint returned ${String(res.status)}${detail ? `: ${detail}` : ""}`);
  }
  const json = (await res.json()) as unknown;
  if (!isTokenResponse(json)) {
    throw new Error("Codex token endpoint returned an unexpected payload (no access_token).");
  }
  return json;
}

// Exchange an authorization code for tokens. `now` defaults to the current time
// but stays injectable for deterministic tests.
export async function exchangeCode(code: string, verifier: string, now: number): Promise<CodexTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: CODEX_CLIENT_ID,
    redirect_uri: CODEX_REDIRECT_URI,
    code_verifier: verifier,
  });
  return tokensFromResponse(await postToken(body), now);
}

// Mint a fresh access token from a refresh token. Carries the prior refresh
// token forward if the server does not rotate it.
export async function refreshTokens(refreshToken: string, now: number): Promise<CodexTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CODEX_CLIENT_ID,
  });
  return tokensFromResponse(await postToken(body), now, refreshToken);
}
