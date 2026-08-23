import { afterEach, describe, expect, test } from "bun:test";
import { withMockedModule } from "../../tests/helpers/mock-module.js";

// getValidCodexToken/getValidXaiToken hit the real home-level auth store and
// refresh endpoints; stub the session layer so this test only exercises the
// scope probe's own HTTP call and status classification. Other suites
// (tests/unit/codex-session.test.ts) import the real modules directly, so the
// mocks must be torn down after this file's tests run rather than leaking
// into the rest of the bun test process.
await withMockedModule(
  import.meta.resolve("./codex/session.js"),
  (real: typeof import("./codex/session.js")) => ({
    ...real,
    getValidCodexToken: async () => ({ access: "codex-token", accountId: "acct-1" }),
  }),
);
await withMockedModule(
  import.meta.resolve("./xai/session.js"),
  (real: typeof import("./xai/session.js")) => ({
    ...real,
    getValidXaiToken: async () => ({ access: "xai-token" }),
  }),
);

const { checkOAuthProviderScope } = await import("./oauth-scope-check.js");

const originalFetch = global.fetch;

function stubFetch(impl: (url: string) => Response | Promise<Response>): void {
  global.fetch = (async (input: RequestInfo | URL) => impl(String(input))) as typeof fetch;
}

describe("checkOAuthProviderScope", () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("codex: ok when the catalog call succeeds", async () => {
    stubFetch(() => new Response(JSON.stringify({ models: ["gpt-5"] }), { status: 200 }));
    const result = await checkOAuthProviderScope("codex", "work");
    expect(result.status).toBe("ok");
  });

  test("codex: insufficient-scope on a definitive 403", async () => {
    stubFetch(() => new Response("forbidden", { status: 403 }));
    const result = await checkOAuthProviderScope("codex", "work");
    expect(result.status).toBe("insufficient-scope");
    if (result.status === "insufficient-scope") {
      expect(result.message).toMatch(/reconnect/i);
      // Must never surface the raw response body.
      expect(result.message).not.toContain("forbidden");
    }
  });

  test("codex: insufficient-scope on a definitive 401", async () => {
    stubFetch(() => new Response("nope", { status: 401 }));
    const result = await checkOAuthProviderScope("codex", "work");
    expect(result.status).toBe("insufficient-scope");
  });

  test("codex: unavailable on a network failure, not blocked", async () => {
    stubFetch(() => {
      throw new Error("fetch failed");
    });
    const result = await checkOAuthProviderScope("codex", "work");
    expect(result.status).toBe("unavailable");
  });

  test("codex: unavailable (not scope failure) on a 500", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    const result = await checkOAuthProviderScope("codex", "work");
    expect(result.status).toBe("unavailable");
  });

  test("xai: ok when the models call succeeds", async () => {
    stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const result = await checkOAuthProviderScope("xai", "personal");
    expect(result.status).toBe("ok");
  });

  test("xai: insufficient-scope on a definitive 403", async () => {
    stubFetch(() => new Response("forbidden", { status: 403 }));
    const result = await checkOAuthProviderScope("xai", "personal");
    expect(result.status).toBe("insufficient-scope");
  });

  test("xai: unavailable on a timeout-style abort", async () => {
    stubFetch(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const result = await checkOAuthProviderScope("xai", "personal");
    expect(result.status).toBe("unavailable");
  });
});
