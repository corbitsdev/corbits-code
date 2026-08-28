import { afterEach, describe, expect, test } from "bun:test";

import { checkOAuthProviderScope } from "./oauth-scope-check.js";

const originalFetch = global.fetch;
const codexTokens = {
  access: "staged-codex-token",
  refresh: "codex-refresh",
  expiresAt: Date.now() + 3_600_000,
  accountId: "acct-staged",
};
const xaiTokens = {
  access: "staged-xai-token",
  refresh: "xai-refresh",
  expiresAt: Date.now() + 3_600_000,
};

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    impl(String(input), init)) as typeof fetch;
}

describe("checkOAuthProviderScope", () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("codex: builds the probe from staged tokens", async () => {
    stubFetch((_url, init) => {
      expect(init?.headers).toMatchObject({
        authorization: "Bearer staged-codex-token",
        "chatgpt-account-id": "acct-staged",
      });
      return new Response(JSON.stringify({ models: ["gpt-5"] }), { status: 200 });
    });
    const result = await checkOAuthProviderScope("codex", codexTokens);
    expect(result.status).toBe("ok");
  });

  test("codex: refreshes expired staged tokens before classifying the probe", async () => {
    const expired = { ...codexTokens, expiresAt: 0 };
    const requests: string[] = [];
    stubFetch((url, init) => {
      requests.push(url);
      if (url.includes("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "refreshed-codex", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      expect(init?.headers).toMatchObject({
        authorization: "Bearer refreshed-codex",
        "chatgpt-account-id": "acct-staged",
      });
      return new Response(JSON.stringify({ models: ["gpt-5"] }), { status: 200 });
    });

    const result = await checkOAuthProviderScope("codex", expired);

    expect(result.status).toBe("ok");
    expect(requests).toHaveLength(2);
    expect(expired.access).toBe("refreshed-codex");
  });

  test("codex: blocks a definitive staged refresh rejection", async () => {
    const expired = { ...codexTokens, expiresAt: 0 };
    stubFetch(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));

    const result = await checkOAuthProviderScope("codex", expired);

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.message).toMatch(/expired|revoked/i);
    }
  });

  test("codex: reports a transient staged refresh failure as unavailable", async () => {
    const expired = { ...codexTokens, expiresAt: 0 };
    stubFetch(() => {
      throw new Error("network down");
    });

    const result = await checkOAuthProviderScope("codex", expired);

    expect(result.status).toBe("unavailable");
  });

  test("codex: blocks a definitive 403 without surfacing the raw body", async () => {
    stubFetch(() => new Response("forbidden", { status: 403 }));
    const result = await checkOAuthProviderScope("codex", codexTokens);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.message).toMatch(/reconnect/i);
      expect(result.message).not.toContain("forbidden");
    }
  });

  test("codex: blocks a definitive 401", async () => {
    stubFetch(() => new Response("nope", { status: 401 }));
    const result = await checkOAuthProviderScope("codex", codexTokens);
    expect(result.status).toBe("blocked");
  });

  test("codex: unavailable on a network failure, not blocked", async () => {
    stubFetch(() => {
      throw new Error("fetch failed");
    });
    const result = await checkOAuthProviderScope("codex", codexTokens);
    expect(result.status).toBe("unavailable");
  });

  test("codex: unavailable (not scope failure) on a 500", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    const result = await checkOAuthProviderScope("codex", codexTokens);
    expect(result.status).toBe("unavailable");
  });

  test("xai: builds the probe from staged tokens", async () => {
    stubFetch((_url, init) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer staged-xai-token" });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const result = await checkOAuthProviderScope("xai", xaiTokens);
    expect(result.status).toBe("ok");
  });

  test("xai: refreshes expired staged tokens before classifying the probe", async () => {
    const expired = { ...xaiTokens, expiresAt: 0 };
    const requests: string[] = [];
    stubFetch((url, init) => {
      requests.push(url);
      if (url.includes("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "refreshed-xai", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      expect(init?.headers).toMatchObject({ authorization: "Bearer refreshed-xai" });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    const result = await checkOAuthProviderScope("xai", expired);

    expect(result.status).toBe("ok");
    expect(requests).toHaveLength(2);
    expect(expired.access).toBe("refreshed-xai");
  });

  test("xai: blocks a definitive staged refresh rejection", async () => {
    const expired = { ...xaiTokens, expiresAt: 0 };
    stubFetch(() => new Response(JSON.stringify({ error: "revoked" }), { status: 401 }));

    const result = await checkOAuthProviderScope("xai", expired);

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.message).toMatch(/expired|revoked/i);
    }
  });

  test("xai: reports a transient staged refresh failure as unavailable", async () => {
    const expired = { ...xaiTokens, expiresAt: 0 };
    stubFetch(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });

    const result = await checkOAuthProviderScope("xai", expired);

    expect(result.status).toBe("unavailable");
  });

  test("xai: blocks a definitive 403", async () => {
    stubFetch(() => new Response("forbidden", { status: 403 }));
    const result = await checkOAuthProviderScope("xai", xaiTokens);
    expect(result.status).toBe("blocked");
  });

  test("xai: unavailable on a timeout-style abort", async () => {
    stubFetch(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const result = await checkOAuthProviderScope("xai", xaiTokens);
    expect(result.status).toBe("unavailable");
  });
});
