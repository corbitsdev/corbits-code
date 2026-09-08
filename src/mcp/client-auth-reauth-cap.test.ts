import { beforeEach, describe, expect, test } from "bun:test";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { withMockedModule } from "../../tests/helpers/mock-module.js";

let finishAuthCalls = 0;
let connectFailuresLeft = 0;
let providerCreates = 0;
let refreshCalls = 0;
let refreshSucceeds = false;
let authEvents: string[] = [];

const fakeProvider = {
  resetAuthorization: async () => undefined,
  redirectToAuthorization: (url: URL) => {
    authEvents.push("authURL");
    void url;
  },
  tokens: () => ({ access_token: "stale", refresh_token: "refresh-me" }),
  refreshToken: async () => {
    refreshCalls += 1;
    authEvents.push("refresh");
    if (!refreshSucceeds) throw new UnauthorizedError("refresh rejected");
    return { access_token: "fresh", refresh_token: "refresh-me" };
  },
};

await withMockedModule(
  import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"),
  (real: typeof import("@modelcontextprotocol/sdk/client/index.js")) => ({
    ...real,
    Client: class {
      async connect(): Promise<void> {
        if (connectFailuresLeft > 0) {
          connectFailuresLeft -= 1;
          throw new UnauthorizedError("authorization required");
        }
      }
      async listTools(): Promise<{ tools: [] }> {
        return { tools: [] };
      }
      async close(): Promise<void> {}
    },
  }),
);

await withMockedModule(
  import.meta.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  (real: typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js")) => ({
    ...real,
    StreamableHTTPClientTransport: class {
      provider?: { redirectToAuthorization?: (url: URL) => void } | undefined;
      constructor(
        _url: URL,
        options?: { authProvider?: { redirectToAuthorization?: (url: URL) => void } | undefined },
      ) {
        this.provider = options?.authProvider;
      }
      async finishAuth(): Promise<void> {
        // The real SDK transport emits the browser URL from auth(); emulate the
        // prompt here so tests can order it against the refresh attempt.
        this.provider?.redirectToAuthorization?.(new URL("https://auth.test/authorize"));
        finishAuthCalls += 1;
        throw new Error("finishAuth exploded");
      }
      get sessionId(): string | undefined {
        return undefined;
      }
    },
  }),
);

await withMockedModule(
  import.meta.resolve("./callback-server.js"),
  (real: typeof import("./callback-server.js")) => ({
    ...real,
    startCallbackServer: async () => ({
      redirectUrl: "http://127.0.0.1:12345/callback",
      expectState: () => undefined,
      waitForCode: async () => "code",
      close: () => undefined,
    }),
  }),
);

await withMockedModule(
  import.meta.resolve("./oauth-provider.js"),
  (real: typeof import("./oauth-provider.js")) => ({
    ...real,
    createOAuthProvider: async () => {
      providerCreates += 1;
      return fakeProvider;
    },
  }),
);

const { connectMCPServer, resetBrowserAuthState, MAX_BROWSER_AUTH_ATTEMPTS } =
  await import("./client.js");

const config = { name: "linear", type: "http" as const, url: "https://mcp.linear.app/mcp" };

async function connectWithAuthPrompt(): Promise<{ ok: boolean; error?: string }> {
  const result = await connectMCPServer(config, {
    onAuthURL: () => {
      authEvents.push("authURL");
    },
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

describe("HTTP MCP re-auth loop prevention", () => {
  beforeEach(() => {
    connectFailuresLeft = 0;
    finishAuthCalls = 0;
    providerCreates = 0;
    refreshCalls = 0;
    refreshSucceeds = false;
    authEvents = [];
    resetBrowserAuthState();
  });

  test("refreshes tokens before any browser re-auth prompt", async () => {
    refreshSucceeds = true;
    connectFailuresLeft = 1;

    const result = await connectWithAuthPrompt();

    expect(result.ok).toBe(true);
    expect(authEvents).toEqual(["refresh"]);
    expect(refreshCalls).toBe(1);
    expect(finishAuthCalls).toBe(0);
  });

  test("a failed refresh still precedes the browser prompt", async () => {
    connectFailuresLeft = Number.POSITIVE_INFINITY;
    // finishAuth always throws, so the episode ends at the failed exchange.
    const result = await connectWithAuthPrompt();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("finishAuth exploded");

    expect(authEvents).toEqual(["refresh", "authURL"]);
    expect(refreshCalls).toBe(1);
  });

  test("failed browser re-auth is capped and pauses re-prompting across episodes", async () => {
    connectFailuresLeft = Number.POSITIVE_INFINITY;

    for (let episode = 0; episode < MAX_BROWSER_AUTH_ATTEMPTS; episode += 1) {
      const result = await connectWithAuthPrompt();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("finishAuth exploded");
    }

    for (let episode = 0; episode < 2; episode += 1) {
      const result = await connectWithAuthPrompt();
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        `MCP authorization for linear failed after ${MAX_BROWSER_AUTH_ATTEMPTS} attempts`,
      );
      expect(result.error).toContain("retrying paused for 5 minutes");
    }

    expect(finishAuthCalls).toBe(MAX_BROWSER_AUTH_ATTEMPTS);
    expect(providerCreates).toBeGreaterThan(MAX_BROWSER_AUTH_ATTEMPTS);
  });

  test("resetBrowserAuthState clears the cap within the process", async () => {
    connectFailuresLeft = Number.POSITIVE_INFINITY;
    for (let episode = 0; episode < MAX_BROWSER_AUTH_ATTEMPTS; episode += 1) {
      const result = await connectWithAuthPrompt();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("finishAuth exploded");
    }
    expect(await connectWithAuthPrompt()).toEqual({
      ok: false,
      error: expect.stringContaining("retrying paused"),
    });

    resetBrowserAuthState();
    const promptsBefore = finishAuthCalls;
    const result = await connectWithAuthPrompt();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("finishAuth exploded");
    expect(finishAuthCalls).toBe(promptsBefore + 1);
  });
});
