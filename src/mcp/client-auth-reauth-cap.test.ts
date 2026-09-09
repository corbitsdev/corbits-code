import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { withMockedModule } from "../../tests/helpers/mock-module.js";

let finishAuthCalls = 0;
let finishAuthError: Error | undefined = new Error("finishAuth exploded");
let connectFailuresLeft = 0;
let callFailuresLeft = 0;
let redirectsPerFailure = 1;
let redirectConcurrently = false;
let providerCreates = 0;
let refreshCalls = 0;
let refreshSucceeds = false;
let authEvents: string[] = [];
let authURLCount = 0;
let liveProvider: { redirectToAuthorization?: (url: URL) => void | Promise<void> } | undefined;

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

async function emitRedirects(
  provider: { redirectToAuthorization?: (url: URL) => void | Promise<void> } | undefined,
): Promise<void> {
  const redirect = () =>
    provider?.redirectToAuthorization?.(new URL("https://auth.test/authorize"));
  if (redirectConcurrently) {
    await Promise.all(Array.from({ length: redirectsPerFailure }, redirect));
  } else {
    for (let call = 0; call < redirectsPerFailure; call += 1) await redirect();
  }
}

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
        liveProvider = transport?.provider;
        if (connectFailuresLeft > 0) {
          connectFailuresLeft -= 1;
          await emitRedirects(transport?.provider);
          throw new UnauthorizedError("authorization required");
        }
      }
      async listTools(): Promise<{ tools: [] }> {
        return { tools: [] };
      }
      async callTool(): Promise<{ content: [] }> {
        if (callFailuresLeft > 0) {
          callFailuresLeft -= 1;
          await emitRedirects(liveProvider);
          throw new UnauthorizedError("authorization required");
        }
        return { content: [] };
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
    callFailuresLeft = 0;
    redirectsPerFailure = 1;
    redirectConcurrently = false;
    finishAuthCalls = 0;
    finishAuthError = new Error("finishAuth exploded");
    providerCreates = 0;
    liveProvider = undefined;
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

  test("uses one custom refresh before prompting when recovery starts without a redirect", async () => {
    refreshSucceeds = true;
    redirectsPerFailure = 0;
    connectFailuresLeft = 1;

    const result = await connectWithAuthPrompt();

    expect(result.ok).toBe(true);
    expect(authEvents).toEqual(["refresh"]);
    expect(refreshCalls).toBe(1);
    expect(finishAuthCalls).toBe(0);
    expect(authURLCount).toBe(0);
  });

  test("does not repeat the SDK refresh after redirecting to authorization", async () => {
    finishAuthError = undefined;
    connectFailuresLeft = 1;

    const result = await connectWithAuthPrompt();

    expect(result.ok).toBe(true);
    expect(authEvents).toEqual(["authURL"]);
    expect(refreshCalls).toBe(0);
    expect(finishAuthCalls).toBe(1);
    expect(authURLCount).toBe(1);
  });

  test("live-call auth episodes share redirect state and stop after three prompts", async () => {
    const connected = await connectMCPServer(config, {
      onAuthURL: () => {
        authURLCount += 1;
      },
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;

    for (let episode = 0; episode < MAX_BROWSER_AUTH_ATTEMPTS; episode += 1) {
      callFailuresLeft = 1;
      await expect(connected.client.call("ping", {}, new AbortController().signal)).rejects.toThrow(
        "finishAuth exploded",
      );
    }
    expect(authURLCount).toBe(MAX_BROWSER_AUTH_ATTEMPTS);

    callFailuresLeft = 1;
    await expect(connected.client.call("ping", {}, new AbortController().signal)).rejects.toThrow(
      "retrying paused",
    );
    expect(authURLCount).toBe(MAX_BROWSER_AUTH_ATTEMPTS);
  });

  test("repeated concurrent redirects emit one counted prompt", async () => {
    const connected = await connectMCPServer(config, {
      onAuthURL: () => {
        authURLCount += 1;
      },
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    redirectsPerFailure = 3;
    redirectConcurrently = true;
    callFailuresLeft = 1;

    await expect(connected.client.call("ping", {}, new AbortController().signal)).rejects.toThrow(
      "finishAuth exploded",
    );

    expect(authURLCount).toBe(1);
    expect(finishAuthCalls).toBe(1);
    expect(refreshCalls).toBe(0);
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

  test("prompts resume five minutes after the third failed episode without a fourth probe", async () => {
    const thirdEpisodeAt = new Date("2026-01-01T00:00:00Z").getTime();
    setSystemTime(thirdEpisodeAt);
    connectFailuresLeft = Number.POSITIVE_INFINITY;
    for (let episode = 0; episode < MAX_BROWSER_AUTH_ATTEMPTS; episode += 1) {
      const result = await connectWithAuthPrompt();
      expect(result.ok).toBe(false);
    }
    expect(authURLCount).toBe(MAX_BROWSER_AUTH_ATTEMPTS);

    setSystemTime(thirdEpisodeAt + BROWSER_AUTH_COOLDOWN_MS + 1);
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
