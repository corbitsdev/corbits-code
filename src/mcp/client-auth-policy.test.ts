import { beforeEach, describe, expect, test } from "bun:test";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { withMockedModule } from "../../tests/helpers/mock-module.js";

let callbackStarts = 0;
let callbackCloses = 0;
let providerCreates = 0;
let transportOptions: unknown[] = [];
let providerServerURL: string | undefined;
let clientConnectError: Error | undefined;
let providerCreateError: Error | undefined;
let clientCloses = 0;
let blockToolDiscovery = false;
let toolDiscoverySignals: (AbortSignal | undefined)[] = [];
let toolDiscoveryAborts = 0;
let blockTokenExchange = false;
let tokenExchangeSignals: (AbortSignal | null | undefined)[] = [];
let tokenExchangeAborts = 0;
let lastTransportAuth: (() => Promise<void>) | undefined;
let tokenRefreshSignals: (AbortSignal | null | undefined)[] = [];
let tokenRefreshAborts = 0;

function hangUntilAbort(
  signal: AbortSignal | null | undefined,
  onAbort: () => void,
  fallback: string,
): Promise<void> {
  return new Promise((_resolve, reject) => {
    const fail = (): void => {
      onAbort();
      reject(signal?.reason ?? new Error(fallback));
    };
    if (signal?.aborted === true) fail();
    else signal?.addEventListener("abort", fail, { once: true });
  });
}

const authProvider = { resetAuthorization: async () => undefined };

await withMockedModule(
  import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"),
  (real: typeof import("@modelcontextprotocol/sdk/client/index.js")) => ({
    ...real,
    Client: class {
      async connect(): Promise<void> {
        if (clientConnectError !== undefined) throw clientConnectError;
      }
      async listTools(
        _params?: unknown,
        options?: { signal?: AbortSignal },
      ): Promise<{ tools: [] }> {
        toolDiscoverySignals.push(options?.signal);
        if (blockToolDiscovery) {
          await new Promise<void>((_resolve, reject) => {
            const signal = options?.signal;
            const onAbort = (): void => {
              toolDiscoveryAborts += 1;
              reject(signal?.reason ?? new Error("tool discovery aborted"));
            };
            if (signal?.aborted === true) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          });
        }
        return { tools: [] };
      }
      async callTool(): Promise<{ content: [] }> {
        if (lastTransportAuth === undefined) throw new Error("no live HTTP transport");
        await lastTransportAuth();
        return { content: [] };
      }
      async close(): Promise<void> {
        clientCloses += 1;
      }
    },
  }),
);

await withMockedModule(
  import.meta.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  (real: typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js")) => ({
    ...real,
    StreamableHTTPClientTransport: class {
      constructor(
        _url: URL,
        private readonly options?: {
          requestInit?: RequestInit;
          fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
        },
      ) {
        transportOptions.push(options);
        lastTransportAuth = () => this.auth();
      }
      async finishAuth(): Promise<void> {
        const signal = this.options?.requestInit?.signal;
        tokenExchangeSignals.push(signal);
        if (blockTokenExchange) {
          await hangUntilAbort(
            signal,
            () => {
              tokenExchangeAborts += 1;
            },
            "token exchange aborted",
          );
        }
      }
      async auth(): Promise<void> {
        // SDK 403 upscoping uses raw `_fetch` with no init.signal. Hang on the
        // connect signal the product also installs as `fetch`, so abort still
        // settles this path.
        const signal = this.options?.requestInit?.signal;
        tokenRefreshSignals.push(signal);
        await hangUntilAbort(
          signal,
          () => {
            tokenRefreshAborts += 1;
          },
          "token refresh aborted",
        );
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
    startCallbackServer: async () => {
      callbackStarts += 1;
      return {
        redirectUrl: "http://127.0.0.1:12345/callback",
        expectState: () => undefined,
        waitForCode: async () => "code",
        close: () => {
          callbackCloses += 1;
        },
      };
    },
  }),
);

await withMockedModule(
  import.meta.resolve("./oauth-provider.js"),
  (real: typeof import("./oauth-provider.js")) => ({
    ...real,
    createOAuthProvider: async (options: { serverURL: string }) => {
      providerCreates += 1;
      providerServerURL = options.serverURL;
      if (providerCreateError !== undefined) throw providerCreateError;
      return authProvider;
    },
  }),
);

const { connectMCPServer, fetchWithConnectAbort } = await import("./client.js");

describe("HTTP MCP auth policy", () => {
  beforeEach(() => {
    callbackStarts = 0;
    callbackCloses = 0;
    providerCreates = 0;
    transportOptions = [];
    providerServerURL = undefined;
    clientConnectError = undefined;
    providerCreateError = undefined;
    clientCloses = 0;
    blockToolDiscovery = false;
    toolDiscoverySignals = [];
    toolDiscoveryAborts = 0;
    blockTokenExchange = false;
    tokenExchangeSignals = [];
    tokenExchangeAborts = 0;
    lastTransportAuth = undefined;
    tokenRefreshSignals = [];
    tokenRefreshAborts = 0;
  });

  test("built-in anonymous Exa treats 401 as a normal failure without OAuth machinery", async () => {
    clientConnectError = new Error("401 Unauthorized");
    const result = await connectMCPServer({
      name: "exa",
      type: "http",
      url: "https://mcp.exa.ai/mcp",
      oauth: false,
    });

    expect(result).toEqual({ ok: false, serverName: "exa", error: "401 Unauthorized" });
    expect(callbackStarts).toBe(0);
    expect(providerCreates).toBe(0);
    expect(transportOptions).toEqual([undefined]);
  });

  test("closes a bound OAuth callback server when provider setup fails", async () => {
    providerCreateError = new Error("provider setup exploded");

    const result = await connectMCPServer({
      name: "linear",
      type: "http",
      url: "https://mcp.linear.app/mcp",
    });

    expect(result).toEqual({
      ok: false,
      serverName: "linear",
      error: "provider setup exploded",
    });
    expect(callbackStarts).toBe(1);
    expect(callbackCloses).toBe(1);
    expect(transportOptions).toEqual([]);
  });

  test("aborts stalled tool discovery and closes HTTP resources", async () => {
    blockToolDiscovery = true;
    const abort = new AbortController();
    const connection = connectMCPServer(
      { name: "linear", type: "http", url: "https://mcp.linear.app/mcp" },
      { signal: abort.signal },
    );
    while (toolDiscoverySignals.length === 0) await Promise.resolve();

    expect(toolDiscoverySignals[0]).toBe(abort.signal);
    abort.abort(new Error("toolset disposed"));
    const result = await connection;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("toolset disposed");
    expect(toolDiscoveryAborts).toBe(1);
    expect(clientCloses).toBe(1);
    expect(callbackCloses).toBe(1);
  });

  test("aborts a stalled post-callback token exchange and closes HTTP resources", async () => {
    blockTokenExchange = true;
    clientConnectError = new UnauthorizedError("authorization required");
    const abort = new AbortController();
    const connection = connectMCPServer(
      { name: "linear", type: "http", url: "https://mcp.linear.app/mcp" },
      { onAuthURL: () => undefined, signal: abort.signal },
    );
    while (tokenExchangeSignals.length === 0) await Promise.resolve();

    expect(tokenExchangeSignals[0]).toBe(abort.signal);
    abort.abort(new Error("toolset disposed"));
    const result = await connection;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("toolset disposed");
    expect(tokenExchangeAborts).toBe(1);
    expect(clientCloses).toBe(1);
    expect(callbackCloses).toBe(1);
  });

  test("aborts a live-transport auth refresh that ignores the transport abort controller", async () => {
    const abort = new AbortController();
    const result = await connectMCPServer(
      { name: "linear", type: "http", url: "https://mcp.linear.app/mcp" },
      { signal: abort.signal },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(transportOptions).toEqual([
      { authProvider, requestInit: { signal: abort.signal }, fetch: expect.any(Function) },
    ]);

    const call = result.client.call("ping", {}, abort.signal);
    while (tokenRefreshSignals.length === 0) await Promise.resolve();
    expect(tokenRefreshSignals[0]).toBe(abort.signal);
    abort.abort(new Error("toolset disposed"));
    await expect(call).rejects.toThrow("toolset disposed");
    expect(tokenRefreshAborts).toBe(1);

    const fetchFn = (
      transportOptions[0] as {
        fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
      }
    ).fetch;
    expect(fetchFn).toBeTypeOf("function");
    await expect(fetchFn!("https://auth.test/token")).rejects.toThrow();
  });

  test("ordinary HTTP creates endpoint-scoped OAuth and passes it to transport", async () => {
    const result = await connectMCPServer({
      name: "exa",
      type: "http",
      url: "https://CUSTOM.example:443/mcp?mode=full#ignored",
    });

    expect(result.ok).toBe(true);
    expect(callbackStarts).toBe(1);
    expect(providerCreates).toBe(1);
    expect(providerServerURL).toBe("https://custom.example/mcp?mode=full");
    expect(transportOptions).toEqual([{ authProvider }]);
  });
});

describe("fetchWithConnectAbort", () => {
  test("rejects when the connect signal aborts OAuth HTTP with no init.signal", async () => {
    const abort = new AbortController();
    let seen: AbortSignal | undefined;
    const fetchFn = fetchWithConnectAbort(abort.signal, (_url, init) => {
      seen = init?.signal ?? undefined;
      return hangUntilAbort(init?.signal, () => undefined, "aborted").then(
        () => new Response(null, { status: 200 }),
      );
    });

    const pending = fetchFn("https://auth.test/token");
    expect(seen).toBe(abort.signal);
    abort.abort(new Error("toolset disposed"));
    await expect(pending).rejects.toThrow("toolset disposed");
  });

  test("composes connect abort with a caller request signal", async () => {
    const connect = new AbortController();
    const request = new AbortController();
    let seen: AbortSignal | undefined;
    const fetchFn = fetchWithConnectAbort(connect.signal, (_url, init) => {
      seen = init?.signal ?? undefined;
      return hangUntilAbort(init?.signal, () => undefined, "aborted").then(
        () => new Response(null, { status: 200 }),
      );
    });

    const pending = fetchFn("https://auth.test/token", { signal: request.signal });
    expect(seen).toBeDefined();
    expect(seen).not.toBe(connect.signal);
    expect(seen).not.toBe(request.signal);
    connect.abort(new Error("toolset disposed"));
    await expect(pending).rejects.toThrow("toolset disposed");
  });
});
