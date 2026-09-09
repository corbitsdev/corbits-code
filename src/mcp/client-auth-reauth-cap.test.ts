import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { withMockedModule } from "../../tests/helpers/mock-module.js";

let finishAuthCalls = 0;
let finishAuthError: Error | undefined = new Error("finishAuth exploded");
let connectFailuresLeft = 0;
let providerCreates = 0;
let refreshCalls = 0;
let refreshSucceeds = false;
let authEvents: string[] = [];
let authURLCount = 0;

const fakeProvider = {
  resetAuthorization: async () => undefined,
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
      async connect(transport?: {
        provider?: {
          redirectToAuthorization?: (url: URL) => void | Promise<void>;
        };
      }): Promise<void> {
        if (connectFailuresLeft > 0) {
          connectFailuresLeft -= 1;
          // Production StreamableHTTPClientTransport calls SDK auth() on HTTP 401,
          // which invokes redirectToAuthorization and then throws UnauthorizedError.
          await transport?.provider?.redirectToAuthorization?.(
            new URL("https://auth.test/authorize"),
          );
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
      provider?: {
        redirectToAuthorization?: (url: URL) => void | Promise<void>;
      };
      constructor(
        _url: URL,
        options?: {
          authProvider?: {
            redirectToAuthorization?: (url: URL) => void | Promise<void>;
          };
        },
      ) {
        if (options?.authProvider !== undefined) this.provider = options.authProvider;
      }
      async finishAuth(): Promise<void> {
        finishAuthCalls += 1;
        if (finishAuthError !== undefined) throw finishAuthError;
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
    createOAuthProvider: async (options: {
      serverName: string;
      onAuthURL: (serverName: string, authorizationUrl: string) => void;
    }) => {
      providerCreates += 1;
      return {
        ...fakeProvider,
        redirectToAuthorization: (url: URL) => {
          options.onAuthURL(options.serverName, url.toString());
        },
      };
    },
  }),
);

const {
  connectMCPServer,
  resetBrowserAuthState,
  MAX_BROWSER_AUTH_ATTEMPTS,
  BROWSER_AUTH_COOLDOWN_MS,
} = await import("./client.js");

const config = { name: "linear", type: "http" as const, url: "https://mcp.linear.app/mcp" };

async function connectWithAuthPrompt(): Promise<{ ok: boolean; error?: string }> {
  const result = await connectMCPServer(config, {
    onAuthURL: () => {
      authURLCount += 1;
      authEvents.push("authURL");
    },
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

describe("HTTP MCP re-auth loop prevention", () => {
  beforeEach(() => {
    connectFailuresLeft = 0;
    finishAuthCalls = 0;
    finishAuthError = new Error("finishAuth exploded");
    providerCreates = 0;
    refreshCalls = 0;
    refreshSucceeds = false;
    authEvents = [];
    authURLCount = 0;
    resetBrowserAuthState();
    setSystemTime();
  });

  afterEach(() => {
    setSystemTime();
  });

  test("refreshes tokens before any browser re-auth prompt", async () => {
    refreshSucceeds = true;
    connectFailuresLeft = 1;

    const result = await connectWithAuthPrompt();

    expect(result.ok).toBe(true);
    expect(authEvents).toEqual(["refresh"]);
    expect(refreshCalls).toBe(1);
    expect(finishAuthCalls).toBe(0);
    expect(authURLCount).toBe(0);
  });

  test("a failed refresh still precedes the browser prompt", async () => {
    connectFailuresLeft = Number.POSITIVE_INFINITY;
    const result = await connectWithAuthPrompt();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("finishAuth exploded");

    expect(authEvents).toEqual(["refresh", "authURL"]);
    expect(refreshCalls).toBe(1);
    expect(authURLCount).toBe(1);
  });

  test("failed browser re-auth is capped and pauses re-prompting across episodes", async () => {
    connectFailuresLeft = Number.POSITIVE_INFINITY;

    for (let episode = 0; episode < MAX_BROWSER_AUTH_ATTEMPTS; episode += 1) {
      const result = await connectWithAuthPrompt();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("finishAuth exploded");
    }
    expect(authURLCount).toBe(MAX_BROWSER_AUTH_ATTEMPTS);
    expect(finishAuthCalls).toBe(MAX_BROWSER_AUTH_ATTEMPTS);

    for (let episode = 0; episode < 2; episode += 1) {
      const result = await connectWithAuthPrompt();
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        `MCP authorization for linear failed after ${MAX_BROWSER_AUTH_ATTEMPTS} attempts`,
      );
      expect(result.error).toContain("retrying paused for 5 minutes");
      expect(result.error).toContain("Retry later after the cooldown");
      expect(result.error).not.toContain("Reconnect the server");
    }

    expect(authURLCount).toBe(MAX_BROWSER_AUTH_ATTEMPTS);
    expect(finishAuthCalls).toBe(MAX_BROWSER_AUTH_ATTEMPTS);
    expect(providerCreates).toBeGreaterThan(MAX_BROWSER_AUTH_ATTEMPTS);
  });

  test("successful interactive auth clears the cap so a later failure can prompt", async () => {
    connectFailuresLeft = Number.POSITIVE_INFINITY;
    for (let episode = 0; episode < 2; episode += 1) {
      const result = await connectWithAuthPrompt();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("finishAuth exploded");
    }
    expect(authURLCount).toBe(2);

    finishAuthError = undefined;
    connectFailuresLeft = 1;
    const recovered = await connectWithAuthPrompt();
    expect(recovered.ok).toBe(true);
    expect(authURLCount).toBe(3);

    finishAuthError = new Error("finishAuth exploded");
    connectFailuresLeft = Number.POSITIVE_INFINITY;
    for (let episode = 0; episode < MAX_BROWSER_AUTH_ATTEMPTS; episode += 1) {
      const result = await connectWithAuthPrompt();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("finishAuth exploded");
    }
    expect(authURLCount).toBe(3 + MAX_BROWSER_AUTH_ATTEMPTS);

    const capped = await connectWithAuthPrompt();
    expect(capped.ok).toBe(false);
    expect(capped.error).toContain("retrying paused");
    expect(authURLCount).toBe(3 + MAX_BROWSER_AUTH_ATTEMPTS);
  });

  test("prompts resume after the cooldown", async () => {
    connectFailuresLeft = Number.POSITIVE_INFINITY;
    for (let episode = 0; episode < MAX_BROWSER_AUTH_ATTEMPTS; episode += 1) {
      const result = await connectWithAuthPrompt();
      expect(result.ok).toBe(false);
    }
    expect(authURLCount).toBe(MAX_BROWSER_AUTH_ATTEMPTS);

    const duringCooldown = await connectWithAuthPrompt();
    expect(duringCooldown.ok).toBe(false);
    expect(duringCooldown.error).toContain("retrying paused");
    expect(authURLCount).toBe(MAX_BROWSER_AUTH_ATTEMPTS);

    setSystemTime(Date.now() + BROWSER_AUTH_COOLDOWN_MS + 1);
    const afterCooldown = await connectWithAuthPrompt();
    expect(afterCooldown.ok).toBe(false);
    expect(afterCooldown.error).toContain("finishAuth exploded");
    expect(authURLCount).toBe(MAX_BROWSER_AUTH_ATTEMPTS + 1);
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
    expect(authURLCount).toBe(MAX_BROWSER_AUTH_ATTEMPTS);

    resetBrowserAuthState();
    const promptsBefore = finishAuthCalls;
    const result = await connectWithAuthPrompt();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("finishAuth exploded");
    expect(finishAuthCalls).toBe(promptsBefore + 1);
    expect(authURLCount).toBe(MAX_BROWSER_AUTH_ATTEMPTS + 1);
  });
});
