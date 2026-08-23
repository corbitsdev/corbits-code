import { afterEach, describe, expect, test } from "bun:test";

import {
  XAI_CLIENT_ID,
  XAI_REDIRECT_URI,
  XAI_TOKEN_URL,
  XAI_TOKEN_TIMEOUT_MS,
} from "./constants.js";
import { buildAuthorizeUrl, exchangeCode, refreshTokens, tokensFromResponse } from "./oauth.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("xAI OAuth", () => {
  test("builds a PKCE authorize URL", () => {
    const url = new URL(
      buildAuthorizeUrl({ verifier: "verifier", challenge: "challenge", method: "S256" }, "state"),
    );
    expect(url.origin + url.pathname).toBe("https://auth.x.ai/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(XAI_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(XAI_REDIRECT_URI);
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state");
    expect(url.searchParams.get("scope")).toContain("api:access");
  });

  test("exchanges an authorization code with PKCE verifier", async () => {
    let body = "";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(XAI_TOKEN_URL);
      expect(init?.method).toBe("POST");
      body = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 10,
          id_token: "id",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    await expect(exchangeCode("code", "verifier", 1000)).resolves.toEqual({
      access: "access",
      refresh: "refresh",
      expiresAt: 11_000,
      idToken: "id",
    });
    const params = new URLSearchParams(body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("code");
    expect(params.get("client_id")).toBe(XAI_CLIENT_ID);
    expect(params.get("redirect_uri")).toBe(XAI_REDIRECT_URI);
    expect(params.get("code_verifier")).toBe("verifier");
  });

  test("carries refresh token forward when refresh response omits it", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "new-access", expires_in: 5 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(refreshTokens("old-refresh", 2000)).resolves.toEqual({
      access: "new-access",
      refresh: "old-refresh",
      expiresAt: 7000,
    });
  });

  test("requires a refresh token on initial exchange", () => {
    expect(() => tokensFromResponse({ access_token: "access" }, 0)).toThrow(/no refresh_token/);
  });
});

describe("xAI token request timeout", () => {
  // A refresh fired on the send path (before each inference call) must not be
  // able to hang forever: an unresponsive token endpoint would otherwise freeze
  // the agent at turn 0 because the send promise never settles and the harness
  // never arms its inference timers. Passing a timeout-backed signal is the
  // regression guard; the platform owns firing that signal after the bound.
  test("passes a timeout signal to the token endpoint", async () => {
    let signal: AbortSignal | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response(JSON.stringify({ access_token: "new-access", expires_in: 5 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await expect(refreshTokens("old-refresh", 2000)).resolves.toEqual({
      access: "new-access",
      refresh: "old-refresh",
      expiresAt: 7000,
    });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    expect(XAI_TOKEN_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
