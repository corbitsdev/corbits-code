import { type } from "arktype";

import {
  XAI_AUTHORIZE_URL,
  XAI_CLIENT_ID,
  XAI_REDIRECT_URI,
  XAI_SCOPES,
  XAI_TOKEN_TIMEOUT_MS,
  XAI_TOKEN_URL,
} from "./constants.js";
import type { Pkce } from "./pkce.js";
import type { XaiTokens } from "./store.js";

export function buildAuthorizeUrl(pkce: Pkce, state: string): string {
  const url = new URL(XAI_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", XAI_CLIENT_ID);
  url.searchParams.set("redirect_uri", XAI_REDIRECT_URI);
  url.searchParams.set("scope", XAI_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", pkce.method);
  url.searchParams.set("state", state);
  return url.toString();
}

// Validate the whole token response, not just access_token: a malformed
// expires_in (e.g. the string "soon") would otherwise survive and compute a NaN
// expiry, which never compares as expired, so the token would never refresh.
const TokenResponseSchema = type({
  access_token: "string",
  "refresh_token?": "string",
  "expires_in?": "number",
  "id_token?": "string",
});
type TokenResponse = typeof TokenResponseSchema.infer;

const DEFAULT_EXPIRES_IN_S = 3600;

export function tokensFromResponse(
  response: TokenResponse,
  now: number,
  previousRefresh?: string,
): XaiTokens {
  const expiresInMs = (response.expires_in ?? DEFAULT_EXPIRES_IN_S) * 1000;
  const refresh = response.refresh_token ?? previousRefresh;
  if (refresh === undefined) {
    throw new Error("xAI token response carried no refresh_token and none was previously stored.");
  }
  return {
    access: response.access_token,
    refresh,
    expiresAt: now + expiresInMs,
    ...(response.id_token !== undefined ? { idToken: response.id_token } : {}),
  };
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  // Refresh runs on the send path before inference, outside the harness timers,
  // so the token request must abort within the bounded timeout rather than hang
  // the agent forever when the proxy stalls.
  const res = await fetch(XAI_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    signal: AbortSignal.timeout(XAI_TOKEN_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`xAI token endpoint returned ${String(res.status)}${detail ? `: ${detail}` : ""}`);
  }
  // AbortSignal.timeout throws a DOMException (name "TimeoutError") when it
  // fires; its message ("The operation timed out") is what callers report.
  const json = TokenResponseSchema(await res.json());
  if (json instanceof type.errors) {
    throw new Error(`xAI token endpoint returned an unexpected payload: ${json.summary}`);
  }
  return json;
}

export async function exchangeCode(code: string, verifier: string, now: number): Promise<XaiTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: XAI_CLIENT_ID,
    redirect_uri: XAI_REDIRECT_URI,
    code_verifier: verifier,
  });
  return tokensFromResponse(await postToken(body), now);
}

export async function refreshTokens(refreshToken: string, now: number): Promise<XaiTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: XAI_CLIENT_ID,
  });
  return tokensFromResponse(await postToken(body), now, refreshToken);
}
