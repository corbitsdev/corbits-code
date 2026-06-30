import {
  CODEX_AUTHORIZE_EXTRA_PARAMS,
  CODEX_AUTHORIZE_URL,
  CODEX_CLIENT_ID,
  CODEX_REDIRECT_URI,
  CODEX_SCOPES,
  CODEX_TOKEN_TIMEOUT_MS,
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
  const accountId = accountIdFromIdToken(response.id_token);
  return {
    access: response.access_token,
    refresh,
    expiresAt: now + expiresInMs,
    ...(accountId !== undefined ? { accountId } : {}),
  };
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    signal: AbortSignal.timeout(CODEX_TOKEN_TIMEOUT_MS),
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
