import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { withMockedModule } from "../../tests/helpers/mock-module.js";

let finishAuthCalls = 0;
let finishAuthError: Error | undefined = new Error("finishAuth exploded");
let connectFailuresLeft = 0;
let listFailuresLeft = 0;
let callFailuresLeft = 0;
let callToolCalls = 0;
let callRedirectsLeft = Number.POSITIVE_INFINITY;
let redirectsPerFailure = 1;
let redirectOnListFailure = false;
let redirectConcurrently = false;
let saveThenRedirectPair = false;
let overlappingSDKSaves = false;
let redirectVerifier: string | undefined;
let providerCreates = 0;
let refreshCalls = 0;
let refreshSucceeds = false;
let authEvents: string[] = [];
let authURLCount = 0;
let authorizedCount = 0;
let waitForCodeCalls = 0;
let storedCodeVerifier: string | undefined;
let exchangedCodeVerifier: string | undefined;
let emittedAuthURL: string | undefined;
let saveStarted = 0;
let refreshGate: Promise<void> | undefined;
let releaseRefresh: (() => void) | undefined;
let callbackGate: Promise<void> | undefined;
let releaseCallback: (() => void) | undefined;
let lastRequestSignal: AbortSignal | undefined;
let retryGate: Promise<void> | undefined;
let releaseRetry: (() => void) | undefined;
let saveGate: Promise<void> | undefined;
let releaseSave: (() => void) | undefined;
interface MockAuthProvider {
  redirectToAuthorization?: (url: URL) => void | Promise<void>;
  saveCodeVerifier?: (codeVerifier: string) => void | Promise<void>;
  codeVerifier?: () => string | undefined;
}
let liveProvider: MockAuthProvider | undefined;

const fakeProvider = {
  resetAuthorization: async () => undefined,
  tokens: () => ({ access_token: "stale", refresh_token: "refresh-me" }),
  refreshToken: async () => {
    refreshCalls += 1;
    authEvents.push("refresh");
    await waitForOptionalGate(refreshGate, lastRequestSignal);
    if (!refreshSucceeds) throw new UnauthorizedError("refresh rejected");
    return { access_token: "fresh", refresh_token: "refresh-me" };
  },
  saveCodeVerifier: async (codeVerifier: string) => {
    storedCodeVerifier = codeVerifier;
    saveStarted += 1;
    await saveGate;
  },
  codeVerifier: () => storedCodeVerifier,
};

async function saveThenRedirect(
  provider: MockAuthProvider | undefined,
  verifier: string,
): Promise<void> {
  await provider?.saveCodeVerifier?.(verifier);
  await provider?.redirectToAuthorization?.(
    new URL(`https://auth.test/authorize?v=${encodeURIComponent(verifier)}`),
  );
}

async function emitRedirects(provider: MockAuthProvider | undefined): Promise<void> {
  if (overlappingSDKSaves) {
    const first = saveThenRedirect(provider, "v1");
    while (saveStarted === 0) await Promise.resolve();
    const second = saveThenRedirect(provider, "v2");
    await Promise.resolve();
    releaseSave?.();
    await Promise.all([first, second]);
    return;
  }
  if (saveThenRedirectPair) {
    const first = saveThenRedirect(provider, "v1");
    await Promise.resolve();
    await Promise.all([first, saveThenRedirect(provider, "v2")]);
    return;
  }
  if (redirectVerifier !== undefined) {
    const verifier = redirectVerifier;
    redirectVerifier = undefined;
    await saveThenRedirect(provider, verifier);
    return;
  }
  const redirect = () =>
    provider?.redirectToAuthorization?.(new URL("https://auth.test/authorize"));
  if (redirectConcurrently) {
    await Promise.all(Array.from({ length: redirectsPerFailure }, redirect));
  } else {
    for (let call = 0; call < redirectsPerFailure; call += 1) await redirect();
  }
}

function waitForOptionalGate(
  gate: Promise<void> | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (gate === undefined) return Promise.resolve();
  if (signal === undefined) return gate;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void gate.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

function waitForGate(signal: AbortSignal): Promise<void> {
  return waitForOptionalGate(callbackGate, signal);
}

await withMockedModule(
  import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"),
  (real: typeof import("@modelcontextprotocol/sdk/client/index.js")) => ({
    ...real,
    Client: class {
      async connect(transport?: { provider?: MockAuthProvider }): Promise<void> {
        liveProvider = transport?.provider;
        if (connectFailuresLeft > 0) {
          connectFailuresLeft -= 1;
          await emitRedirects(transport?.provider);
          throw new UnauthorizedError("authorization required");
        }
      }
      async listTools(): Promise<{ tools: [] }> {
        if (listFailuresLeft > 0) {
          listFailuresLeft -= 1;
          if (redirectOnListFailure) {
            await liveProvider?.redirectToAuthorization?.(new URL("https://auth.test/authorize"));
          }
          throw new UnauthorizedError("authorization required");
        }
        return { tools: [] };
      }
      async callTool(): Promise<{ content: [] }> {
        callToolCalls += 1;
        if (callFailuresLeft > 0) {
          callFailuresLeft -= 1;
          if (callRedirectsLeft > 0) {
            callRedirectsLeft -= 1;
            await emitRedirects(liveProvider);
          }
          throw new UnauthorizedError("authorization required");
        }
        await waitForOptionalGate(retryGate, lastRequestSignal);
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
      provider?: MockAuthProvider;
      constructor(
        _url: URL,
        options?: { authProvider?: MockAuthProvider; requestInit?: RequestInit },
      ) {
        if (options?.authProvider !== undefined) this.provider = options.authProvider;
        const signal = options?.requestInit?.signal;
        if (signal !== undefined && signal !== null) lastRequestSignal = signal;
      }
      async finishAuth(): Promise<void> {
        finishAuthCalls += 1;
        exchangedCodeVerifier = this.provider?.codeVerifier?.();
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
      waitForCode: async (signal: AbortSignal) => {
        waitForCodeCalls += 1;
        await waitForGate(signal);
        return "code";
      },
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
    listFailuresLeft = 0;
    callFailuresLeft = 0;
    callToolCalls = 0;
    callRedirectsLeft = Number.POSITIVE_INFINITY;
    redirectsPerFailure = 1;
    redirectOnListFailure = false;
    redirectConcurrently = false;
    saveThenRedirectPair = false;
    overlappingSDKSaves = false;
    redirectVerifier = undefined;
    finishAuthCalls = 0;
    finishAuthError = new Error("finishAuth exploded");
    providerCreates = 0;
    liveProvider = undefined;
    refreshCalls = 0;
    refreshSucceeds = false;
    authEvents = [];
    authURLCount = 0;
    authorizedCount = 0;
    waitForCodeCalls = 0;
    storedCodeVerifier = undefined;
    exchangedCodeVerifier = undefined;
    emittedAuthURL = undefined;
    saveStarted = 0;
    refreshGate = undefined;
    releaseRefresh = undefined;
    callbackGate = undefined;
    releaseCallback = undefined;
    saveGate = undefined;
    releaseSave = undefined;
    lastRequestSignal = undefined;
    retryGate = undefined;
    releaseRetry = undefined;
    resetBrowserAuthState();
    setSystemTime();
  });

  afterEach(() => {
    resetBrowserAuthState();
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

  test("rejects promptly when refresh and an auth probe fail without emitting a URL", async () => {
    const connected = await connectMCPServer(config, {
      onAuthURL: () => (authURLCount += 1),
      onAuthorized: () => (authorizedCount += 1),
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    redirectsPerFailure = 0;
    callFailuresLeft = 1;
    listFailuresLeft = 1;

    await expect(connected.client.call("ping", {}, new AbortController().signal)).rejects.toThrow(
      "authorization required",
    );

    expect(refreshCalls).toBe(1);
    expect(authURLCount).toBe(0);
    expect(waitForCodeCalls).toBe(0);
    expect(authorizedCount).toBe(0);
  });

  test("shares live-call recovery across concurrent unauthorized calls", async () => {
    finishAuthError = undefined;
    const connected = await connectMCPServer(config, {
      onAuthURL: () => (authURLCount += 1),
      onAuthorized: () => (authorizedCount += 1),
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    redirectsPerFailure = 0;
    callFailuresLeft = 2;
    listFailuresLeft = 1;
    redirectOnListFailure = true;

    const calls = [
      connected.client.call("first", { value: 1 }, new AbortController().signal),
      connected.client.call("second", { value: 2 }, new AbortController().signal),
    ];

    await expect(Promise.all(calls)).resolves.toEqual(["", ""]);
    expect(refreshCalls).toBe(1);
    expect(authURLCount).toBe(1);
    expect(waitForCodeCalls).toBe(1);
    expect(finishAuthCalls).toBe(1);
    expect(callToolCalls).toBe(4);
    expect(authorizedCount).toBe(1);
  });

  test("does not start browser fallback while shared refresh is pending", async () => {
    const connected = await connectMCPServer(config, { onAuthURL: () => (authURLCount += 1) });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    refreshGate = new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    redirectsPerFailure = 0;
    callFailuresLeft = 1;
    const first = connected.client.call("first", {}, new AbortController().signal);
    while (refreshCalls === 0) await Promise.resolve();

    redirectsPerFailure = 1;
    callFailuresLeft = 1;
    const second = connected.client.call("second", {}, new AbortController().signal);
    await Promise.resolve();
    expect(authURLCount).toBe(0);

    releaseRefresh?.();
    await expect(Promise.all([first, second])).rejects.toThrow("finishAuth exploded");
    expect(refreshCalls).toBe(1);
    expect(authURLCount).toBe(1);
    expect(waitForCodeCalls).toBe(1);
  });

  test("caller abort does not cancel shared recovery for another call", async () => {
    finishAuthError = undefined;
    callbackGate = new Promise((resolve) => {
      releaseCallback = resolve;
    });
    const connected = await connectMCPServer(config, { onAuthURL: () => (authURLCount += 1) });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    callFailuresLeft = 2;
    const firstAbort = new AbortController();
    const first = connected.client.call("first", {}, firstAbort.signal);
    const second = connected.client.call("second", {}, new AbortController().signal);
    while (waitForCodeCalls === 0) await Promise.resolve();

    firstAbort.abort(new Error("caller stopped"));
    await expect(first).rejects.toThrow("caller stopped");
    releaseCallback?.();

    await expect(second).resolves.toBe("");
    expect(waitForCodeCalls).toBe(1);
    expect(finishAuthCalls).toBe(1);
    expect(authURLCount).toBe(1);
  });

  test("aborted waiter still fires onAuthorized when background finishAuth succeeds", async () => {
    finishAuthError = undefined;
    callbackGate = new Promise((resolve) => {
      releaseCallback = resolve;
    });
    const connected = await connectMCPServer(config, {
      onAuthURL: () => (authURLCount += 1),
      onAuthorized: () => (authorizedCount += 1),
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    callFailuresLeft = 1;
    const abort = new AbortController();
    const call = connected.client.call("ping", {}, abort.signal);
    while (authURLCount === 0 || waitForCodeCalls === 0) await Promise.resolve();

    abort.abort(new Error("caller stopped"));
    await expect(call).rejects.toThrow("caller stopped");
    expect(authorizedCount).toBe(0);

    releaseCallback?.();
    while (finishAuthCalls === 0) await Promise.resolve();
    for (let tick = 0; tick < 20 && authorizedCount === 0; tick += 1) await Promise.resolve();
    expect(authorizedCount).toBe(1);
    expect(finishAuthCalls).toBe(1);

    finishAuthError = new Error("finishAuth exploded");
    for (let episode = 0; episode < MAX_BROWSER_AUTH_ATTEMPTS; episode += 1) {
      callFailuresLeft = 1;
      await expect(connected.client.call("ping", {}, new AbortController().signal)).rejects.toThrow(
        "finishAuth exploded",
      );
    }
    expect(authURLCount).toBe(1 + MAX_BROWSER_AUTH_ATTEMPTS);
    callFailuresLeft = 1;
    await expect(connected.client.call("ping", {}, new AbortController().signal)).rejects.toThrow(
      "retrying paused",
    );
    expect(authURLCount).toBe(1 + MAX_BROWSER_AUTH_ATTEMPTS);
  });

  test("refresh-only recovery clears prior browser-cap counts", async () => {
    const connected = await connectMCPServer(config, {
      onAuthURL: () => (authURLCount += 1),
      onAuthorized: () => (authorizedCount += 1),
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;

    for (let episode = 0; episode < 2; episode += 1) {
      callFailuresLeft = 1;
      await expect(connected.client.call("ping", {}, new AbortController().signal)).rejects.toThrow(
        "finishAuth exploded",
      );
    }
    expect(authURLCount).toBe(2);
    expect(authorizedCount).toBe(0);

    refreshSucceeds = true;
    finishAuthError = undefined;
    redirectsPerFailure = 0;
    callFailuresLeft = 1;
    await expect(connected.client.call("ping", {}, new AbortController().signal)).resolves.toBe("");
    expect(authorizedCount).toBe(1);
    expect(authURLCount).toBe(2);

    refreshSucceeds = false;
    finishAuthError = new Error("finishAuth exploded");
    redirectsPerFailure = 1;
    for (let episode = 0; episode < MAX_BROWSER_AUTH_ATTEMPTS; episode += 1) {
      callFailuresLeft = 1;
      await expect(connected.client.call("ping", {}, new AbortController().signal)).rejects.toThrow(
        "finishAuth exploded",
      );
    }
    expect(authURLCount).toBe(2 + MAX_BROWSER_AUTH_ATTEMPTS);

    callFailuresLeft = 1;
    await expect(connected.client.call("ping", {}, new AbortController().signal)).rejects.toThrow(
      "retrying paused",
    );
    expect(authURLCount).toBe(2 + MAX_BROWSER_AUTH_ATTEMPTS);
  });

  test("client close aborts the shared callback waiter", async () => {
    finishAuthError = undefined;
    callbackGate = new Promise((resolve) => {
      releaseCallback = resolve;
    });
    const connected = await connectMCPServer(config, { onAuthURL: () => (authURLCount += 1) });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    callFailuresLeft = 1;
    const call = connected.client.call("ping", {}, new AbortController().signal);
    while (waitForCodeCalls === 0) await Promise.resolve();

    await connected.client.close();

    await expect(call).rejects.toHaveProperty("name", "AbortError");
    expect(finishAuthCalls).toBe(0);
  });

  test("client close during hung refresh does not emit a browser prompt", async () => {
    const connected = await connectMCPServer(config, { onAuthURL: () => (authURLCount += 1) });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    refreshGate = new Promise(() => undefined);
    redirectsPerFailure = 0;
    callFailuresLeft = 1;
    const call = connected.client.call("ping", {}, new AbortController().signal);
    while (refreshCalls === 0) await Promise.resolve();

    await connected.client.close();

    await expect(call).rejects.toHaveProperty("name", "AbortError");
    expect(authURLCount).toBe(0);
    expect(waitForCodeCalls).toBe(0);
  });

  test("client close after recovery during retry still fires onAuthorized", async () => {
    finishAuthError = undefined;
    retryGate = new Promise(() => undefined);
    const connected = await connectMCPServer(config, {
      onAuthURL: () => (authURLCount += 1),
      onAuthorized: () => (authorizedCount += 1),
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    callFailuresLeft = 1;
    const call = connected.client.call("ping", {}, new AbortController().signal);
    while (finishAuthCalls === 0 || callToolCalls < 2) await Promise.resolve();
    expect(authorizedCount).toBe(0);

    await connected.client.close();

    await expect(call).rejects.toHaveProperty("name", "AbortError");
    expect(authorizedCount).toBe(1);
    expect(authURLCount).toBe(1);
  });

  test("late retry success from a prior recovery does not fire onAuthorized after a new recovery starts", async () => {
    finishAuthError = undefined;
    const connected = await connectMCPServer(config, {
      onAuthURL: () => (authURLCount += 1),
      onAuthorized: () => (authorizedCount += 1),
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    retryGate = new Promise((resolve) => {
      releaseRetry = resolve;
    });
    callFailuresLeft = 2;
    const first = connected.client.call("first", {}, new AbortController().signal);
    const second = connected.client.call("second", {}, new AbortController().signal);
    while (callToolCalls < 4) await Promise.resolve();

    callbackGate = new Promise((resolve) => {
      releaseCallback = resolve;
    });
    callFailuresLeft = 1;
    const third = connected.client.call("third", {}, new AbortController().signal);
    while (waitForCodeCalls < 2) await Promise.resolve();

    releaseRetry?.();
    await expect(first).resolves.toBe("");
    await expect(second).resolves.toBe("");
    expect(authorizedCount).toBe(0);

    releaseCallback?.();
    await expect(third).resolves.toBe("");
    expect(authorizedCount).toBe(1);
    expect(authURLCount).toBe(2);
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

  test("prompts resume five minutes after the third failed episode", async () => {
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

  test("first in-episode saveCodeVerifier wins until the episode ends", async () => {
    finishAuthError = undefined;
    saveThenRedirectPair = true;
    const connected = await connectMCPServer(config, {
      onAuthURL: () => {
        authURLCount += 1;
      },
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    callFailuresLeft = 1;

    await expect(connected.client.call("ping", {}, new AbortController().signal)).resolves.toBe("");

    expect(authURLCount).toBe(1);
    expect(waitForCodeCalls).toBe(1);
    expect(finishAuthCalls).toBe(1);
    expect(exchangedCodeVerifier).toBe("v1");
    expect(storedCodeVerifier).toBe("v1");
  });

  test("overlapping SDK-order saves emit the first verifier's authorize URL", async () => {
    finishAuthError = undefined;
    overlappingSDKSaves = true;
    saveGate = new Promise((resolve) => {
      releaseSave = resolve;
    });
    const connected = await connectMCPServer(config, {
      onAuthURL: (_name, url) => {
        authURLCount += 1;
        emittedAuthURL = url;
      },
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    callFailuresLeft = 1;

    await expect(connected.client.call("ping", {}, new AbortController().signal)).resolves.toBe("");

    expect(authURLCount).toBe(1);
    expect(waitForCodeCalls).toBe(1);
    expect(finishAuthCalls).toBe(1);
    expect(exchangedCodeVerifier).toBe("v1");
    expect(storedCodeVerifier).toBe("v1");
    expect(emittedAuthURL).toBe("https://auth.test/authorize?v=v1");
  });

  test("refresh-skip unfreezes so a later browser episode can save a new verifier", async () => {
    refreshSucceeds = true;
    finishAuthError = undefined;
    const connected = await connectMCPServer(config, {
      onAuthURL: () => {
        authURLCount += 1;
      },
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;

    refreshGate = new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    redirectsPerFailure = 0;
    callFailuresLeft = 1;
    const first = connected.client.call("first", {}, new AbortController().signal);
    while (refreshCalls === 0) await Promise.resolve();

    const skipped = saveThenRedirect(liveProvider, "v-refresh");
    await Promise.resolve();
    expect(authURLCount).toBe(0);

    releaseRefresh?.();
    await skipped;
    await expect(first).resolves.toBe("");
    expect(authURLCount).toBe(0);
    expect(waitForCodeCalls).toBe(0);
    expect(storedCodeVerifier).toBe("v-refresh");

    refreshSucceeds = false;
    redirectVerifier = "v-later";
    redirectsPerFailure = 1;
    callFailuresLeft = 1;
    await expect(connected.client.call("second", {}, new AbortController().signal)).resolves.toBe(
      "",
    );

    expect(authURLCount).toBe(1);
    expect(waitForCodeCalls).toBe(1);
    expect(exchangedCodeVerifier).toBe("v-later");
    expect(storedCodeVerifier).toBe("v-later");
  });

  test("does not clear the cap or fire onAuthorized until a retried tool call succeeds", async () => {
    finishAuthError = undefined;
    const connected = await connectMCPServer(config, {
      onAuthURL: () => {
        authURLCount += 1;
      },
      onAuthorized: () => {
        authorizedCount += 1;
      },
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;

    callFailuresLeft = 2;
    callRedirectsLeft = 1;
    await expect(connected.client.call("ping", {}, new AbortController().signal)).rejects.toThrow(
      "authorization required",
    );
    expect(authorizedCount).toBe(0);
    expect(authURLCount).toBe(1);
    expect(waitForCodeCalls).toBe(1);
    expect(finishAuthCalls).toBe(1);

    finishAuthError = new Error("finishAuth exploded");
    callRedirectsLeft = Number.POSITIVE_INFINITY;
    for (let episode = 0; episode < 2; episode += 1) {
      callFailuresLeft = 1;
      await expect(connected.client.call("ping", {}, new AbortController().signal)).rejects.toThrow(
        "finishAuth exploded",
      );
    }
    expect(authURLCount).toBe(3);
    expect(authorizedCount).toBe(0);

    callFailuresLeft = 1;
    await expect(connected.client.call("ping", {}, new AbortController().signal)).rejects.toThrow(
      "retrying paused",
    );
    expect(authURLCount).toBe(3);
    expect(authorizedCount).toBe(0);
  });

  test("clears the cap and fires onAuthorized after a retried tool call succeeds", async () => {
    finishAuthError = undefined;
    const connected = await connectMCPServer(config, {
      onAuthURL: () => {
        authURLCount += 1;
      },
      onAuthorized: () => {
        authorizedCount += 1;
      },
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;

    callFailuresLeft = 2;
    callRedirectsLeft = 1;
    await expect(connected.client.call("ping", {}, new AbortController().signal)).rejects.toThrow(
      "authorization required",
    );
    expect(authorizedCount).toBe(0);

    callRedirectsLeft = Number.POSITIVE_INFINITY;
    callFailuresLeft = 1;
    await expect(connected.client.call("ping", {}, new AbortController().signal)).resolves.toBe("");
    expect(authorizedCount).toBe(1);
    expect(authURLCount).toBe(2);

    finishAuthError = new Error("finishAuth exploded");
    for (let episode = 0; episode < MAX_BROWSER_AUTH_ATTEMPTS; episode += 1) {
      callFailuresLeft = 1;
      await expect(connected.client.call("ping", {}, new AbortController().signal)).rejects.toThrow(
        "finishAuth exploded",
      );
    }
    expect(authURLCount).toBe(2 + MAX_BROWSER_AUTH_ATTEMPTS);

    callFailuresLeft = 1;
    await expect(connected.client.call("ping", {}, new AbortController().signal)).rejects.toThrow(
      "retrying paused",
    );
    expect(authURLCount).toBe(2 + MAX_BROWSER_AUTH_ATTEMPTS);
    expect(authorizedCount).toBe(1);
  });
});
