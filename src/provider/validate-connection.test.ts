import { afterEach, expect, test } from "bun:test";

import { validateProviderConnection } from "./validate-connection.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("resolves ok when the models endpoint responds ok", async () => {
  let requestedURL = "";
  let requestedAuth: string | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedURL = String(input);
    requestedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await validateProviderConnection({
    baseURL: "https://api.example.com/v1/",
    apiKey: "sk-key",
  });

  expect(result.ok).toBe(true);
  expect(requestedURL).toBe("https://api.example.com/v1/models");
  expect(requestedAuth).toBe("Bearer sk-key");
});

test("omits the Authorization header for keyless providers", async () => {
  let sawAuthHeader = false;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sawAuthHeader =
      "Authorization" in ((init?.headers as Record<string, string> | undefined) ?? {});
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const result = await validateProviderConnection({ baseURL: "http://localhost:11434/v1" });

  expect(result.ok).toBe(true);
  expect(sawAuthHeader).toBe(false);
});

test("fails with status detail on a non-ok response", async () => {
  globalThis.fetch = (async () =>
    new Response("invalid api key", {
      status: 401,
      statusText: "Unauthorized",
    })) as unknown as typeof fetch;

  const result = await validateProviderConnection({
    baseURL: "https://api.example.com/v1",
    apiKey: "bad",
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("401");
    expect(result.error).toContain("invalid api key");
  }
});

test("fails when the request itself fails", async () => {
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;

  const result = await validateProviderConnection({ baseURL: "http://localhost:9/v1" });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("ECONNREFUSED");
  }
});

test("fails on an invalid base URL without fetching", async () => {
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const result = await validateProviderConnection({ baseURL: "not a url" });

  expect(result.ok).toBe(false);
  expect(fetched).toBe(false);
});

test("times out against a blackholed host instead of hanging", async () => {
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;

  const result = await validateProviderConnection({
    baseURL: "https://blackhole.example.com/v1",
    timeoutMs: 25,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("timed out");
  }
});
