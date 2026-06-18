import {
  XAI_AUTHORIZE_URL,
  XAI_CLIENT_ID,
  XAI_REDIRECT_URI,
  XAI_SCOPES,
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
  const res = await fetch(XAI_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`xAI token endpoint returned ${String(res.status)}${detail ? `: ${detail}` : ""}`);
  }
  const json = (await res.json()) as unknown;
  if (!isTokenResponse(json)) {
    throw new Error("xAI token endpoint returned an unexpected payload (no access_token).");
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
