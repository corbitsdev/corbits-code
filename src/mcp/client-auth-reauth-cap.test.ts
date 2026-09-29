import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  mockMcpCallbackServerModule,
  mockMcpClientModule,
  mockMcpOAuthProviderModule,
  mockMcpTransportModule,
  type MockAuthProvider,
} from "../testkit/mcp-sdk-mock.js";

interface MockState {
  finishAuthCalls: number;
  finishAuthError: Error | undefined;
  connectFailuresLeft: number;
  listFailuresLeft: number;
  callFailuresLeft: number;
  callToolCalls: number;
  callRedirectsLeft: number;
  redirectsPerFailure: number;
  redirectOnListFailure: boolean;
  redirectConcurrently: boolean;
  saveThenRedirectPair: boolean;
  overlappingSDKSaves: boolean;
  redirectVerifier: string | undefined;
  providerCreates: number;
  refreshCalls: number;
  refreshSucceeds: boolean;
  authEvents: string[];
  authURLCount: number;
  authorizedCount: number;
  waitForCodeCalls: number;
  storedCodeVerifier: string | undefined;
  exchangedCodeVerifier: string | undefined;
  emittedAuthURL: string | undefined;
  saveStarted: number;
  refreshGate: Promise<void> | undefined;
  releaseRefresh: (() => void) | undefined;
  callbackGate: Promise<void> | undefined;
  releaseCallback: (() => void) | undefined;
  lastRequestSignal: AbortSignal | undefined;
  retryGate: Promise<void> | undefined;
  releaseRetry: (() => void) | undefined;
  saveGate: Promise<void> | undefined;
  releaseSave: (() => void) | undefined;
  liveProvider: MockAuthProvider | undefined;
}

function freshMockState(): MockState {
  return {
    finishAuthCalls: 0,
    finishAuthError: new Error("finishAuth exploded"),
    connectFailuresLeft: 0,
    listFailuresLeft: 0,
    callFailuresLeft: 0,
    callToolCalls: 0,
    callRedirectsLeft: Number.POSITIVE_INFINITY,
    redirectsPerFailure: 1,
    redirectOnListFailure: false,
    redirectConcurrently: false,
    saveThenRedirectPair: false,
    overlappingSDKSaves: false,
    redirectVerifier: undefined,
    providerCreates: 0,
    refreshCalls: 0,
    refreshSucceeds: false,
    authEvents: [],
    authURLCount: 0,
    authorizedCount: 0,
    waitForCodeCalls: 0,
    storedCodeVerifier: undefined,
    exchangedCodeVerifier: undefined,
    emittedAuthURL: undefined,
    saveStarted: 0,
    refreshGate: undefined,
    releaseRefresh: undefined,
    callbackGate: undefined,
    releaseCallback: undefined,
    lastRequestSignal: undefined,
    retryGate: undefined,
    releaseRetry: undefined,
    saveGate: undefined,
    releaseSave: undefined,
    liveProvider: undefined,
  };
}

// The SDK mocks below close over this object, so per-test resets must
// mutate it via Object.assign rather than rebind the binding.
const mock = freshMockState();

const fakeProvider = {
  resetAuthorization: async () => undefined,
  tokens: () => ({ access_token: "stale", refresh_token: "refresh-me" }),
  refreshToken: async () => {
    mock.refreshCalls += 1;
    mock.authEvents.push("refresh");
    await waitForOptionalGate(mock.refreshGate, mock.lastRequestSignal);
    if (!mock.refreshSucceeds) throw new UnauthorizedError("refresh rejected");
    return { access_token: "fresh", refresh_token: "refresh-me" };
  },
  saveCodeVerifier: async (codeVerifier: string) => {
    mock.storedCodeVerifier = codeVerifier;
    mock.saveStarted += 1;
    await mock.saveGate;
  },
  codeVerifier: () => mock.storedCodeVerifier,
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

async function emitRedirects(
  provider: MockAuthProvider | undefined,
): Promise<void> {
  if (mock.overlappingSDKSaves) {
    const first = saveThenRedirect(provider, "v1");
    while (mock.saveStarted === 0) await Promise.resolve();
    const second = saveThenRedirect(provider, "v2");
    await Promise.resolve();
    mock.releaseSave?.();
    await Promise.all([first, second]);
    return;
  }
  if (mock.saveThenRedirectPair) {
    const first = saveThenRedirect(provider, "v1");
    await Promise.resolve();
    await Promise.all([first, saveThenRedirect(provider, "v2")]);
    return;
  }
  if (mock.redirectVerifier !== undefined) {
    const verifier = mock.redirectVerifier;
    mock.redirectVerifier = undefined;
    await saveThenRedirect(provider, verifier);
    return;
  }
  const redirect = () =>
    provider?.redirectToAuthorization?.(new URL("https://auth.test/authorize"));
  if (mock.redirectConcurrently) {
    await Promise.all(
      Array.from({ length: mock.redirectsPerFailure }, redirect),
    );
  } else {
    for (let call = 0; call < mock.redirectsPerFailure; call += 1)
      await redirect();
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

function waitForGate(signal: AbortSignal | undefined): Promise<void> {
  return waitForOptionalGate(mock.callbackGate, signal);
}

await mockMcpClientModule(mock, {
  connect: async (provider) => {
    if (mock.connectFailuresLeft > 0) {
      mock.connectFailuresLeft -= 1;
      await emitRedirects(provider);
      throw new UnauthorizedError("authorization required");
    }
  },
  listTools: async () => {
    if (mock.listFailuresLeft > 0) {
      mock.listFailuresLeft -= 1;
      if (mock.redirectOnListFailure) {
        await mock.liveProvider?.redirectToAuthorization?.(
          new URL("https://auth.test/authorize"),
        );
      }
      throw new UnauthorizedError("authorization required");
    }
    return { tools: [] };
  },
  callTool: async () => {
    mock.callToolCalls += 1;
    if (mock.callFailuresLeft > 0) {
      mock.callFailuresLeft -= 1;
      if (mock.callRedirectsLeft > 0) {
        mock.callRedirectsLeft -= 1;
        await emitRedirects(mock.liveProvider);
      }
      throw new UnauthorizedError("authorization required");
    }
    await waitForOptionalGate(mock.retryGate, mock.lastRequestSignal);
    return { content: [] };
  },
  close: async () => undefined,
});

await mockMcpTransportModule(mock, {
  finishAuth: async (self) => {
    mock.finishAuthCalls += 1;
    mock.exchangedCodeVerifier = self.provider?.codeVerifier?.();
    if (mock.finishAuthError !== undefined) throw mock.finishAuthError;
  },
});

await mockMcpCallbackServerModule({
  waitForCode: async (signal) => {
    mock.waitForCodeCalls += 1;
    await waitForGate(signal);
    return "code";
  },
  close: () => undefined,
});

await mockMcpOAuthProviderModule(
  async (options: {
    serverName: string;
    onAuthURL: (serverName: string, authorizationUrl: string) => void;
  }) => {
    mock.providerCreates += 1;
    return {
      ...fakeProvider,
      redirectToAuthorization: (url: URL) => {
        options.onAuthURL(options.serverName, url.toString());
      },
    };
  },
);

const {
  connectMCPServer,
  resetBrowserAuthState,
  setBrowserAuthWaitMs,
  MAX_BROWSER_AUTH_ATTEMPTS,
  BROWSER_AUTH_COOLDOWN_MS,
} = await import("./client.js");

const config = {
  name: "linear",
  type: "http" as const,
  url: "https://mcp.linear.app/mcp",
};

type ConnectedClient = Extract<
  Awaited<ReturnType<typeof connectMCPServer>>,
  { ok: true }
>;

async function connectWithAuthPrompt(): Promise<{
  ok: boolean;
  error?: string;
  authPending?: boolean;
}> {
  const result = await connectMCPServer(config, {
    onAuthURL: () => {
      mock.authURLCount += 1;
      mock.authEvents.push("authURL");
    },
  });
  return result.ok
    ? { ok: true }
    : {
        ok: false,
        error: result.error,
        ...(result.authPending === true ? { authPending: true } : {}),
      };
}

/**
 * Drives MAX_BROWSER_AUTH_ATTEMPTS failed live-call auth episodes against an
 * open client, then asserts the paused state: one more failure reports
 * "retrying paused" without emitting further prompts. `authURLsBefore` is the
 * prompt count already accumulated before the episodes run.
 */
async function runCappedEpisodes(
  connected: ConnectedClient,
  authURLsBefore: number,
): Promise<void> {
  for (let episode = 0; episode < MAX_BROWSER_AUTH_ATTEMPTS; episode += 1) {
    mock.callFailuresLeft = 1;
    await expect(
      connected.client.call("ping", {}, new AbortController().signal),
    ).rejects.toThrow("finishAuth exploded");
  }
  expect(mock.authURLCount).toBe(
    authURLsBefore + MAX_BROWSER_AUTH_ATTEMPTS,
  );

  mock.callFailuresLeft = 1;
  await expect(
    connected.client.call("ping", {}, new AbortController().signal),
  ).rejects.toThrow("retrying paused");
  expect(mock.authURLCount).toBe(
    authURLsBefore + MAX_BROWSER_AUTH_ATTEMPTS,
  );
}

/** Connect-path twin of runCappedEpisodes for the episodes themselves. */
async function runCappedConnectEpisodes(
  assertExplodedError: boolean,
): Promise<void> {
  for (let episode = 0; episode < MAX_BROWSER_AUTH_ATTEMPTS; episode += 1) {
    const result = await connectWithAuthPrompt();
    expect(result.ok).toBe(false);
    if (assertExplodedError)
      expect(result.error).toContain("finishAuth exploded");
  }
}

describe("HTTP MCP re-auth loop prevention", () => {
  beforeEach(() => {
    Object.assign(mock, freshMockState());
    resetBrowserAuthState();
    setSystemTime();
  });

  afterEach(() => {
    resetBrowserAuthState();
    setSystemTime();
  });

  test("uses one custom refresh before prompting when recovery starts without a redirect", async () => {
    mock.refreshSucceeds = true;
    mock.redirectsPerFailure = 0;
    mock.connectFailuresLeft = 1;

    const result = await connectWithAuthPrompt();

    expect(result.ok).toBe(true);
    expect(mock.authEvents).toEqual(["refresh"]);
    expect(mock.refreshCalls).toBe(1);
    expect(mock.finishAuthCalls).toBe(0);
    expect(mock.authURLCount).toBe(0);
  });

  test("rejects promptly when refresh and an auth probe fail without emitting a URL", async () => {
    const connected = await connectMCPServer(config, {
      onAuthURL: () => (mock.authURLCount += 1),
      onAuthorized: () => (mock.authorizedCount += 1),
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    mock.redirectsPerFailure = 0;
    mock.callFailuresLeft = 1;
    mock.listFailuresLeft = 1;

    await expect(
      connected.client.call("ping", {}, new AbortController().signal),
    ).rejects.toThrow("authorization required");

    expect(mock.refreshCalls).toBe(1);
    expect(mock.authURLCount).toBe(0);
    expect(mock.waitForCodeCalls).toBe(0);
    expect(mock.authorizedCount).toBe(0);
  });

  test("shares live-call recovery across concurrent unauthorized calls", async () => {
    mock.finishAuthError = undefined;
    const connected = await connectMCPServer(config, {
      onAuthURL: () => (mock.authURLCount += 1),
      onAuthorized: () => (mock.authorizedCount += 1),
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    mock.redirectsPerFailure = 0;
    mock.callFailuresLeft = 2;
    mock.listFailuresLeft = 1;
    mock.redirectOnListFailure = true;

    const calls = [
      connected.client.call(
        "first",
        { value: 1 },
        new AbortController().signal,
      ),
      connected.client.call(
        "second",
        { value: 2 },
        new AbortController().signal,
      ),
    ];

    await expect(Promise.all(calls)).resolves.toEqual(["", ""]);
    expect(mock.refreshCalls).toBe(1);
    expect(mock.authURLCount).toBe(1);
    expect(mock.waitForCodeCalls).toBe(1);
    expect(mock.finishAuthCalls).toBe(1);
    expect(mock.callToolCalls).toBe(4);
    expect(mock.authorizedCount).toBe(1);
  });

  test("does not start browser fallback while shared refresh is pending", async () => {
    const connected = await connectMCPServer(config, {
      onAuthURL: () => (mock.authURLCount += 1),
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    mock.refreshGate = new Promise((resolve) => {
      mock.releaseRefresh = resolve;
    });
    mock.redirectsPerFailure = 0;
    mock.callFailuresLeft = 1;
    const first = connected.client.call(
      "first",
      {},
      new AbortController().signal,
    );
    while (mock.refreshCalls === 0) await Promise.resolve();

    mock.redirectsPerFailure = 1;
    mock.callFailuresLeft = 1;
    const second = connected.client.call(
      "second",
      {},
      new AbortController().signal,
    );
    await Promise.resolve();
    expect(mock.authURLCount).toBe(0);

    mock.releaseRefresh?.();
    await expect(Promise.all([first, second])).rejects.toThrow(
      "finishAuth exploded",
    );
    expect(mock.refreshCalls).toBe(1);
    expect(mock.authURLCount).toBe(1);
    expect(mock.waitForCodeCalls).toBe(1);
  });

  test("caller abort does not cancel shared recovery for another call", async () => {
    mock.finishAuthError = undefined;
    mock.callbackGate = new Promise((resolve) => {
      mock.releaseCallback = resolve;
    });
    const connected = await connectMCPServer(config, {
      onAuthURL: () => (mock.authURLCount += 1),
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    mock.callFailuresLeft = 2;
    const firstAbort = new AbortController();
    const first = connected.client.call("first", {}, firstAbort.signal);
    const second = connected.client.call(
      "second",
      {},
      new AbortController().signal,
    );
    while (mock.waitForCodeCalls === 0) await Promise.resolve();

    firstAbort.abort(new Error("caller stopped"));
    await expect(first).rejects.toThrow("caller stopped");
    mock.releaseCallback?.();

    await expect(second).resolves.toBe("");
    expect(mock.waitForCodeCalls).toBe(1);
    expect(mock.finishAuthCalls).toBe(1);
    expect(mock.authURLCount).toBe(1);
  });

  test("aborted waiter still fires onAuthorized when background finishAuth succeeds", async () => {
    mock.finishAuthError = undefined;
    mock.callbackGate = new Promise((resolve) => {
      mock.releaseCallback = resolve;
    });
    const connected = await connectMCPServer(config, {
      onAuthURL: () => (mock.authURLCount += 1),
      onAuthorized: () => (mock.authorizedCount += 1),
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    mock.callFailuresLeft = 1;
    const abort = new AbortController();
    const call = connected.client.call("ping", {}, abort.signal);
    while (mock.authURLCount === 0 || mock.waitForCodeCalls === 0)
      await Promise.resolve();

    abort.abort(new Error("caller stopped"));
    await expect(call).rejects.toThrow("caller stopped");
    expect(mock.authorizedCount).toBe(0);

    mock.releaseCallback?.();
    while (mock.finishAuthCalls === 0) await Promise.resolve();
    for (let tick = 0; tick < 20 && mock.authorizedCount === 0; tick += 1)
      await Promise.resolve();
    expect(mock.authorizedCount).toBe(1);
    expect(mock.finishAuthCalls).toBe(1);

    mock.finishAuthError = new Error("finishAuth exploded");
    await runCappedEpisodes(connected, 1);
  });

  test("refresh-only recovery clears prior browser-cap counts", async () => {
    const connected = await connectMCPServer(config, {
      onAuthURL: () => (mock.authURLCount += 1),
      onAuthorized: () => (mock.authorizedCount += 1),
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;

    mock.callFailuresLeft = 1;
    await expect(
      connected.client.call("ping", {}, new AbortController().signal),
    ).rejects.toThrow("finishAuth exploded");
    expect(mock.authURLCount).toBe(1);
    expect(mock.authorizedCount).toBe(0);

    mock.refreshSucceeds = true;
    mock.finishAuthError = undefined;
    mock.redirectsPerFailure = 0;
    mock.callFailuresLeft = 1;
    await expect(
      connected.client.call("ping", {}, new AbortController().signal),
    ).resolves.toBe("");
    expect(mock.authorizedCount).toBe(1);
    expect(mock.authURLCount).toBe(1);

    mock.refreshSucceeds = false;
    mock.finishAuthError = new Error("finishAuth exploded");
    mock.redirectsPerFailure = 1;
    await runCappedEpisodes(connected, 1);
  });

  test("client close aborts the shared callback waiter", async () => {
    mock.finishAuthError = undefined;
    mock.callbackGate = new Promise((resolve) => {
      mock.releaseCallback = resolve;
    });
    const connected = await connectMCPServer(config, {
      onAuthURL: () => (mock.authURLCount += 1),
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    mock.callFailuresLeft = 1;
    const call = connected.client.call(
      "ping",
      {},
      new AbortController().signal,
    );
    while (mock.waitForCodeCalls === 0) await Promise.resolve();

    await connected.client.close();

    await expect(call).rejects.toHaveProperty("name", "AbortError");
    expect(mock.finishAuthCalls).toBe(0);
  });

  test("client close during hung refresh does not emit a browser prompt", async () => {
    const connected = await connectMCPServer(config, {
      onAuthURL: () => (mock.authURLCount += 1),
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    mock.refreshGate = new Promise(() => undefined);
    mock.redirectsPerFailure = 0;
    mock.callFailuresLeft = 1;
    const call = connected.client.call(
      "ping",
      {},
      new AbortController().signal,
    );
    while (mock.refreshCalls === 0) await Promise.resolve();

    await connected.client.close();

    await expect(call).rejects.toHaveProperty("name", "AbortError");
    expect(mock.authURLCount).toBe(0);
    expect(mock.waitForCodeCalls).toBe(0);
  });

  test("client close after recovery during retry still fires onAuthorized", async () => {
    mock.finishAuthError = undefined;
    mock.retryGate = new Promise(() => undefined);
    const connected = await connectMCPServer(config, {
      onAuthURL: () => (mock.authURLCount += 1),
      onAuthorized: () => (mock.authorizedCount += 1),
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    mock.callFailuresLeft = 1;
    const call = connected.client.call(
      "ping",
      {},
      new AbortController().signal,
    );
    while (mock.finishAuthCalls === 0 || mock.callToolCalls < 2)
      await Promise.resolve();
    expect(mock.authorizedCount).toBe(0);

    await connected.client.close();

    await expect(call).rejects.toHaveProperty("name", "AbortError");
    expect(mock.authorizedCount).toBe(1);
    expect(mock.authURLCount).toBe(1);
  });

  test("late retry success from a prior recovery does not fire onAuthorized after a new recovery starts", async () => {
    mock.finishAuthError = undefined;
    const connected = await connectMCPServer(config, {
      onAuthURL: () => (mock.authURLCount += 1),
      onAuthorized: () => (mock.authorizedCount += 1),
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    mock.retryGate = new Promise((resolve) => {
      mock.releaseRetry = resolve;
    });
    mock.callFailuresLeft = 2;
    const first = connected.client.call(
      "first",
      {},
      new AbortController().signal,
    );
    const second = connected.client.call(
      "second",
      {},
      new AbortController().signal,
    );
    while (mock.callToolCalls < 4) await Promise.resolve();

    mock.retryGate = undefined;
    mock.refreshSucceeds = true;
    mock.redirectsPerFailure = 0;
    mock.callFailuresLeft = 1;
    const third = connected.client.call(
      "third",
      {},
      new AbortController().signal,
    );
    await expect(third).resolves.toBe("");
    expect(mock.authorizedCount).toBe(1);
    expect(mock.authURLCount).toBe(1);

    mock.releaseRetry?.();
    await expect(first).resolves.toBe("");
    await expect(second).resolves.toBe("");
    expect(mock.authorizedCount).toBe(1);
    expect(mock.waitForCodeCalls).toBe(1);
  });

  test("does not repeat the SDK refresh after redirecting to authorization", async () => {
    mock.finishAuthError = undefined;
    mock.connectFailuresLeft = 1;

    const result = await connectWithAuthPrompt();

    expect(result.ok).toBe(true);
    expect(mock.authEvents).toEqual(["authURL"]);
    expect(mock.refreshCalls).toBe(0);
    expect(mock.finishAuthCalls).toBe(1);
    expect(mock.authURLCount).toBe(1);
  });

  test("reconnect during in-flight waitForCode does not emit a second prompt", async () => {
    mock.connectFailuresLeft = Number.POSITIVE_INFINITY;
    mock.callbackGate = new Promise(() => undefined);
    const firstAbort = new AbortController();
    const first = connectMCPServer(config, {
      onAuthURL: () => (mock.authURLCount += 1),
      signal: firstAbort.signal,
    });
    while (mock.authURLCount === 0 || mock.waitForCodeCalls === 0)
      await Promise.resolve();
    expect(mock.authURLCount).toBe(1);

    const second = await connectWithAuthPrompt();

    expect(second.ok).toBe(false);
    expect(second.error).toContain("retrying paused");
    expect(mock.authURLCount).toBe(1);
    expect(mock.waitForCodeCalls).toBe(1);

    firstAbort.abort();
    await expect(first).resolves.toMatchObject({ ok: false });
  });

  test("live-call auth episodes share redirect state and stop after one prompt", async () => {
    const connected = await connectMCPServer(config, {
      onAuthURL: () => {
        mock.authURLCount += 1;
      },
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;

    await runCappedEpisodes(connected, 0);
  });

  test("repeated concurrent redirects emit one counted prompt", async () => {
    const connected = await connectMCPServer(config, {
      onAuthURL: () => {
        mock.authURLCount += 1;
      },
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    mock.redirectsPerFailure = 3;
    mock.redirectConcurrently = true;
    mock.callFailuresLeft = 1;

    await expect(
      connected.client.call("ping", {}, new AbortController().signal),
    ).rejects.toThrow("finishAuth exploded");

    expect(mock.authURLCount).toBe(1);
    expect(mock.finishAuthCalls).toBe(1);
    expect(mock.refreshCalls).toBe(0);
  });

  test("failed browser re-auth is capped and pauses re-prompting across episodes", async () => {
    mock.connectFailuresLeft = Number.POSITIVE_INFINITY;

    await runCappedConnectEpisodes(true);
    expect(mock.authURLCount).toBe(MAX_BROWSER_AUTH_ATTEMPTS);
    expect(mock.finishAuthCalls).toBe(MAX_BROWSER_AUTH_ATTEMPTS);

    for (let episode = 0; episode < 2; episode += 1) {
      const result = await connectWithAuthPrompt();
      expect(result.ok).toBe(false);
      // The cap is an unfinished authorization, not a dead server: the TUI
      // keeps the prompt-box auth marker rather than painting a failure row.
      expect(result.authPending).toBe(true);
      expect(result.error).toContain(
        `MCP authorization for linear failed after ${MAX_BROWSER_AUTH_ATTEMPTS} ${MAX_BROWSER_AUTH_ATTEMPTS === 1 ? "attempt" : "attempts"}`,
      );
    }

    expect(mock.authURLCount).toBe(MAX_BROWSER_AUTH_ATTEMPTS);
    expect(mock.finishAuthCalls).toBe(MAX_BROWSER_AUTH_ATTEMPTS);
    expect(mock.providerCreates).toBeGreaterThan(MAX_BROWSER_AUTH_ATTEMPTS);
  });

  test("successful interactive auth clears the cap so a later failure can prompt", async () => {
    mock.finishAuthError = undefined;
    mock.connectFailuresLeft = 1;
    const recovered = await connectWithAuthPrompt();
    expect(recovered.ok).toBe(true);
    expect(mock.authURLCount).toBe(1);

    mock.finishAuthError = new Error("finishAuth exploded");
    mock.connectFailuresLeft = Number.POSITIVE_INFINITY;
    await runCappedConnectEpisodes(true);
    expect(mock.authURLCount).toBe(1 + MAX_BROWSER_AUTH_ATTEMPTS);

    const capped = await connectWithAuthPrompt();
    expect(capped.ok).toBe(false);
    expect(capped.error).toContain("retrying paused");
    expect(mock.authURLCount).toBe(1 + MAX_BROWSER_AUTH_ATTEMPTS);
  });

  test("prompts resume five minutes after the capped failed episode", async () => {
    const thirdEpisodeAt = new Date("2026-01-01T00:00:00Z").getTime();
    setSystemTime(thirdEpisodeAt);
    mock.connectFailuresLeft = Number.POSITIVE_INFINITY;
    await runCappedConnectEpisodes(false);
    expect(mock.authURLCount).toBe(MAX_BROWSER_AUTH_ATTEMPTS);

    setSystemTime(thirdEpisodeAt + BROWSER_AUTH_COOLDOWN_MS + 1);
    const afterCooldown = await connectWithAuthPrompt();
    expect(afterCooldown.ok).toBe(false);
    expect(afterCooldown.error).toContain("finishAuth exploded");
    expect(mock.authURLCount).toBe(MAX_BROWSER_AUTH_ATTEMPTS + 1);
  });

  test("resetBrowserAuthState clears the cap within the process", async () => {
    mock.connectFailuresLeft = Number.POSITIVE_INFINITY;
    await runCappedConnectEpisodes(true);
    expect(await connectWithAuthPrompt()).toEqual({
      ok: false,
      error: expect.stringContaining("retrying paused"),
      authPending: true,
    });
    expect(mock.authURLCount).toBe(MAX_BROWSER_AUTH_ATTEMPTS);

    resetBrowserAuthState();
    const promptsBefore = mock.finishAuthCalls;
    const result = await connectWithAuthPrompt();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("finishAuth exploded");
    expect(mock.finishAuthCalls).toBe(promptsBefore + 1);
    expect(mock.authURLCount).toBe(MAX_BROWSER_AUTH_ATTEMPTS + 1);
  });

  test("first in-episode saveCodeVerifier wins until the episode ends", async () => {
    mock.finishAuthError = undefined;
    mock.saveThenRedirectPair = true;
    const connected = await connectMCPServer(config, {
      onAuthURL: () => {
        mock.authURLCount += 1;
      },
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    mock.callFailuresLeft = 1;

    await expect(
      connected.client.call("ping", {}, new AbortController().signal),
    ).resolves.toBe("");

    expect(mock.authURLCount).toBe(1);
    expect(mock.waitForCodeCalls).toBe(1);
    expect(mock.finishAuthCalls).toBe(1);
    expect(mock.exchangedCodeVerifier).toBe("v1");
    expect(mock.storedCodeVerifier).toBe("v1");
  });

  test("overlapping SDK-order saves emit the first verifier's authorize URL", async () => {
    mock.finishAuthError = undefined;
    mock.overlappingSDKSaves = true;
    mock.saveGate = new Promise((resolve) => {
      mock.releaseSave = resolve;
    });
    const connected = await connectMCPServer(config, {
      onAuthURL: (_name, url) => {
        mock.authURLCount += 1;
        mock.emittedAuthURL = url;
      },
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    mock.callFailuresLeft = 1;

    await expect(
      connected.client.call("ping", {}, new AbortController().signal),
    ).resolves.toBe("");

    expect(mock.authURLCount).toBe(1);
    expect(mock.waitForCodeCalls).toBe(1);
    expect(mock.finishAuthCalls).toBe(1);
    expect(mock.exchangedCodeVerifier).toBe("v1");
    expect(mock.storedCodeVerifier).toBe("v1");
    expect(mock.emittedAuthURL).toBe("https://auth.test/authorize?v=v1");
  });

  test("refresh-skip unfreezes so a later browser episode can save a new verifier", async () => {
    mock.refreshSucceeds = true;
    mock.finishAuthError = undefined;
    const connected = await connectMCPServer(config, {
      onAuthURL: () => {
        mock.authURLCount += 1;
      },
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;

    mock.refreshGate = new Promise((resolve) => {
      mock.releaseRefresh = resolve;
    });
    mock.redirectsPerFailure = 0;
    mock.callFailuresLeft = 1;
    const first = connected.client.call(
      "first",
      {},
      new AbortController().signal,
    );
    while (mock.refreshCalls === 0) await Promise.resolve();

    const skipped = saveThenRedirect(mock.liveProvider, "v-refresh");
    await Promise.resolve();
    expect(mock.authURLCount).toBe(0);

    mock.releaseRefresh?.();
    await skipped;
    await expect(first).resolves.toBe("");
    expect(mock.authURLCount).toBe(0);
    expect(mock.waitForCodeCalls).toBe(0);
    expect(mock.storedCodeVerifier).toBe("v-refresh");

    mock.refreshSucceeds = false;
    mock.redirectVerifier = "v-later";
    mock.redirectsPerFailure = 1;
    mock.callFailuresLeft = 1;
    await expect(
      connected.client.call("second", {}, new AbortController().signal),
    ).resolves.toBe("");

    expect(mock.authURLCount).toBe(1);
    expect(mock.waitForCodeCalls).toBe(1);
    expect(mock.exchangedCodeVerifier).toBe("v-later");
    expect(mock.storedCodeVerifier).toBe("v-later");
  });

  test("does not clear the cap or fire onAuthorized until a retried tool call succeeds", async () => {
    mock.finishAuthError = undefined;
    const connected = await connectMCPServer(config, {
      onAuthURL: () => {
        mock.authURLCount += 1;
      },
      onAuthorized: () => {
        mock.authorizedCount += 1;
      },
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;

    mock.callFailuresLeft = 2;
    mock.callRedirectsLeft = 1;
    await expect(
      connected.client.call("ping", {}, new AbortController().signal),
    ).rejects.toThrow("authorization required");
    expect(mock.authorizedCount).toBe(0);
    expect(mock.authURLCount).toBe(1);
    expect(mock.waitForCodeCalls).toBe(1);
    expect(mock.finishAuthCalls).toBe(1);

    mock.finishAuthError = new Error("finishAuth exploded");
    mock.callRedirectsLeft = Number.POSITIVE_INFINITY;
    mock.callFailuresLeft = 1;
    await expect(
      connected.client.call("ping", {}, new AbortController().signal),
    ).rejects.toThrow("retrying paused");
    expect(mock.authURLCount).toBe(1);
    expect(mock.authorizedCount).toBe(0);
  });

  test("clears the cap and fires onAuthorized after a retried tool call succeeds", async () => {
    mock.finishAuthError = undefined;
    const connected = await connectMCPServer(config, {
      onAuthURL: () => {
        mock.authURLCount += 1;
      },
      onAuthorized: () => {
        mock.authorizedCount += 1;
      },
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;

    mock.callFailuresLeft = 1;
    mock.callRedirectsLeft = 1;
    await expect(
      connected.client.call("ping", {}, new AbortController().signal),
    ).resolves.toBe("");
    expect(mock.authorizedCount).toBe(1);
    expect(mock.authURLCount).toBe(1);

    mock.finishAuthError = new Error("finishAuth exploded");
    mock.callRedirectsLeft = Number.POSITIVE_INFINITY;
    await runCappedEpisodes(connected, 1);
    expect(mock.authorizedCount).toBe(1);
  });

  test("ignored browser wait times out as disconnected and still counts the prompt", async () => {
    setBrowserAuthWaitMs(50);
    mock.connectFailuresLeft = Number.POSITIVE_INFINITY;
    mock.callbackGate = new Promise(() => undefined);

    const result = await connectWithAuthPrompt();

    expect(result.ok).toBe(false);
    expect(result.authPending).toBe(true);
    expect(result.error).toContain("timed out waiting for the browser");
    expect(result.error).toContain("disconnected");
    expect(mock.authURLCount).toBe(1);
    expect(mock.waitForCodeCalls).toBe(1);

    const capped = await connectWithAuthPrompt();
    expect(capped.ok).toBe(false);
    expect(capped.authPending).toBe(true);
    expect(capped.error).toContain("retrying paused");
    expect(mock.authURLCount).toBe(1);
  });

  test("a failure that is not the authorization itself is not auth-pending", async () => {
    mock.connectFailuresLeft = Number.POSITIVE_INFINITY;

    const result = await connectWithAuthPrompt();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("finishAuth exploded");
    expect(result.authPending).toBeUndefined();
  });
});
