// mcp_connect / mcp_oauth emission sites: every connect attempt and browser
// wait reports one enum-only outcome. Leak assertions serialize the whole
// PostHog batch, so a server name, URL, command path, or provider denial
// smuggled under another key must fail the test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mockMcpCallbackServerModule,
  mockMcpClientModule,
  mockMcpOAuthProviderModule,
  mockMcpTransportModule,
  type MockAuthProvider,
} from "../../testkit/mcp-sdk-mock.js";
import {
  classifyMcpConnectResult,
  classifyMcpOAuthResult,
  classifyMcpTransport,
} from "../telemetry/classify.js";
import {
  createTelemetry,
  NOOP_TELEMETRY,
  type Telemetry,
} from "../telemetry/index.js";
import { setTelemetry } from "../telemetry/singleton.js";
import type { Settings } from "../config/settings.js";

interface BatchBody {
  batch: { event: string; properties: Record<string, unknown> }[];
}

function harness(): {
  telemetry: Telemetry;
  wire: () => Promise<string>;
  events: () => Promise<BatchBody["batch"]>;
} {
  const bodies: BatchBody[] = [];
  const fetchFn = ((_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string) as BatchBody);
    return Promise.resolve(new Response("1", { status: 200 }));
  }) as unknown as typeof fetch;
  const settings: Settings = {
    providers: {},
    telemetry: { installationId: "install-id" },
  };
  const telemetry = createTelemetry({
    settings,
    env: {},
    fetchFn,
    apiKey: "test-key",
  });
  const wire = async (): Promise<string> => {
    await telemetry.flush();
    return JSON.stringify(bodies);
  };
  return {
    telemetry,
    wire,
    events: async () => {
      await telemetry.flush();
      return bodies.flatMap((body) => body.batch);
    },
  };
}

// Identifying fixtures: employer-named server, internal URL, local command
// path. None of these strings may reach the wire.
const SERVER_NAME = "acme-internal-hr";
const SERVER_URL = "https://hr.acme-internal.example.com/mcp";
const SERVER_COMMAND = "/opt/acme-internal/bin/hr-server";

const mock = {
  liveProvider: undefined as MockAuthProvider | undefined,
  lastRequestSignal: undefined as AbortSignal | undefined,
  connectFailuresLeft: 0,
  failNextConnect: undefined as Error | undefined,
  waitForCodeCalls: 0,
  finishAuthCalls: 0,
  callbackGate: undefined as Promise<void> | undefined,
};

await mockMcpClientModule(mock, {
  connect: async (provider) => {
    if (mock.failNextConnect !== undefined) {
      const err = mock.failNextConnect;
      mock.failNextConnect = undefined;
      throw err;
    }
    if (mock.connectFailuresLeft > 0) {
      mock.connectFailuresLeft -= 1;
      await provider?.redirectToAuthorization?.(
        new URL("https://auth.test/authorize"),
      );
      const { UnauthorizedError } =
        await import("@modelcontextprotocol/sdk/client/auth.js");
      throw new UnauthorizedError("authorization required");
    }
  },
  listTools: async () => ({ tools: [] }),
  callTool: async () => ({ content: [] }),
  close: async () => undefined,
});

await mockMcpTransportModule(mock, {
  finishAuth: async () => {
    mock.finishAuthCalls += 1;
  },
});

await mockMcpCallbackServerModule({
  // Mirrors the real loopback server: abort rejects the pending wait, a
  // rejected gate surfaces the provider denial, otherwise the code arrives.
  waitForCode: async (signal) => {
    mock.waitForCodeCalls += 1;
    if (mock.callbackGate !== undefined) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(signal.reason);
          return;
        }
        const onAbort = (): void => {
          signal?.removeEventListener("abort", onAbort);
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        void Promise.resolve(mock.callbackGate).then(
          () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          },
          (err: unknown) => {
            signal?.removeEventListener("abort", onAbort);
            reject(err);
          },
        );
      });
    }
    signal?.throwIfAborted();
    return "code-from-browser";
  },
  close: () => undefined,
});

await mockMcpOAuthProviderModule(
  async (options: {
    serverName: string;
    onAuthURL: (serverName: string, authorizationUrl: string) => void;
  }) => {
    const provider = {
      resetAuthorization: async () => undefined,
      tokens: () => undefined,
      refreshToken: async () => {
        throw new Error("no refresh token");
      },
      saveCodeVerifier: async () => undefined,
      codeVerifier: () => undefined,
      redirectToAuthorization: (url: URL) => {
        options.onAuthURL(options.serverName, url.toString());
      },
    };
    return provider;
  },
);

const {
  BROWSER_AUTH_WAIT_MS,
  connectMCPServer,
  resetBrowserAuthState,
  setBrowserAuthWaitMs,
} = await import("./client.js");

beforeEach(() => {
  mock.liveProvider = undefined;
  mock.lastRequestSignal = undefined;
  mock.connectFailuresLeft = 0;
  mock.failNextConnect = undefined;
  mock.waitForCodeCalls = 0;
  mock.finishAuthCalls = 0;
  mock.callbackGate = undefined;
  resetBrowserAuthState();
});

afterEach(() => {
  resetBrowserAuthState();
  setBrowserAuthWaitMs(BROWSER_AUTH_WAIT_MS);
  setTelemetry(NOOP_TELEMETRY);
});

describe("classifyMcpTransport", () => {
  test("reports the connect-path predicate, never the server identity", () => {
    expect(classifyMcpTransport({ type: "http" })).toBe("http");
    expect(classifyMcpTransport({ url: SERVER_URL })).toBe("http");
    // An http-typed entry wins even when a command is also set — the same
    // predicate connectMCPServer dispatches on.
    expect(
      classifyMcpTransport({ type: "http", url: SERVER_URL, command: "x" }),
    ).toBe("http");
    expect(classifyMcpTransport({ type: "stdio" })).toBe("stdio");
    expect(classifyMcpTransport({ command: SERVER_COMMAND })).toBe("stdio");
    expect(classifyMcpTransport({})).toBe("stdio");
  });
});

describe("classifyMcpConnectResult", () => {
  test("ok wins; an offered-but-unfinished browser auth reports auth", () => {
    expect(classifyMcpConnectResult({ ok: true })).toBe("ok");
    expect(classifyMcpConnectResult({ ok: false, authPending: true })).toBe(
      "auth",
    );
  });

  test("timeout-shaped failures report timeout; everything else is fail", () => {
    expect(
      classifyMcpConnectResult({
        ok: false,
        error: "connect timed out after 5000ms",
      }),
    ).toBe("timeout");
    expect(classifyMcpConnectResult({ ok: false, error: "spawn ENOENT" })).toBe(
      "fail",
    );
    expect(classifyMcpConnectResult({ ok: false })).toBe("fail");
  });
});

describe("classifyMcpOAuthResult", () => {
  test("only a timed-out wait reports timeout", () => {
    expect(classifyMcpOAuthResult(new Error("wait timed out"))).toBe("timeout");
    // Abandoned waits, closed servers, and provider denials are all the
    // operator not completing the flow.
    expect(classifyMcpOAuthResult(new Error("aborted"))).toBe("cancelled");
    expect(
      classifyMcpOAuthResult(new Error("Authorization failed: access_denied")),
    ).toBe("cancelled");
    expect(classifyMcpOAuthResult("not an error")).toBe("cancelled");
  });
});

describe("mcp_connect emission", () => {
  test("a failed stdio spawn reports stdio/fail with no identity on the wire", async () => {
    const { telemetry, wire, events } = harness();
    setTelemetry(telemetry);
    // The OS refuses the spawn, like a missing local binary in production;
    // the error text carries the command path and must stay local.
    mock.failNextConnect = new Error(`spawn ${SERVER_COMMAND} ENOENT`);

    const result = await connectMCPServer({
      name: SERVER_NAME,
      command: SERVER_COMMAND,
    });
    expect(result.ok).toBe(false);

    const captured = await events();
    expect(captured.map((e) => e.event)).toEqual(["mcp_connect"]);
    expect(captured[0]?.properties.transport).toBe("stdio");
    expect(captured[0]?.properties.result).toBe("fail");
    const body = await wire();
    expect(body).not.toContain("acme");
    expect(body).not.toContain(SERVER_COMMAND);
  });

  test("a clean http connect reports http/ok with no URL on the wire", async () => {
    const { telemetry, wire, events } = harness();
    setTelemetry(telemetry);

    const result = await connectMCPServer({
      name: SERVER_NAME,
      type: "http",
      url: SERVER_URL,
      oauth: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) await result.client.close();

    const captured = await events();
    expect(captured.map((e) => e.event)).toEqual(["mcp_connect"]);
    expect(captured[0]?.properties.transport).toBe("http");
    expect(captured[0]?.properties.result).toBe("ok");
    const body = await wire();
    expect(body).not.toContain("acme");
    expect(body).not.toContain("hr.acme-internal.example.com");
  });
});

describe("mcp_oauth emission", () => {
  test("a completed browser flow reports completed, then the connect reports ok", async () => {
    const { telemetry, wire, events } = harness();
    setTelemetry(telemetry);
    mock.connectFailuresLeft = 1;

    const result = await connectMCPServer(
      { name: SERVER_NAME, type: "http", url: SERVER_URL },
      { onAuthURL: () => undefined },
    );
    expect(result.ok).toBe(true);
    if (result.ok) await result.client.close();

    const captured = await events();
    expect(captured.map((e) => e.event)).toEqual(["mcp_oauth", "mcp_connect"]);
    expect(captured[0]?.properties.result).toBe("completed");
    expect(captured[1]?.properties.transport).toBe("http");
    expect(captured[1]?.properties.result).toBe("ok");
    expect(mock.finishAuthCalls).toBe(1);
    expect(await wire()).not.toContain("acme");
  });

  test("an expired callback wait reports timeout and the connect reports auth", async () => {
    const { telemetry, wire, events } = harness();
    setTelemetry(telemetry);
    setBrowserAuthWaitMs(20);
    mock.connectFailuresLeft = Number.POSITIVE_INFINITY;
    // The operator never completes the browser flow; only the deadline ends it.
    mock.callbackGate = new Promise(() => undefined);

    const result = await connectMCPServer(
      { name: SERVER_NAME, type: "http", url: SERVER_URL },
      { onAuthURL: () => undefined },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.authPending).toBe(true);

    const captured = await events();
    expect(captured.map((e) => e.event)).toEqual(["mcp_oauth", "mcp_connect"]);
    expect(captured[0]?.properties.result).toBe("timeout");
    expect(captured[1]?.properties.transport).toBe("http");
    expect(captured[1]?.properties.result).toBe("auth");
    expect(await wire()).not.toContain("acme");
  });

  test("an aborted connect reports cancelled with no denial text on the wire", async () => {
    const { telemetry, wire, events } = harness();
    setTelemetry(telemetry);
    mock.connectFailuresLeft = Number.POSITIVE_INFINITY;
    mock.callbackGate = new Promise(() => undefined);
    const controller = new AbortController();

    const connecting = connectMCPServer(
      { name: SERVER_NAME, type: "http", url: SERVER_URL },
      { onAuthURL: () => undefined, signal: controller.signal },
    );
    while (mock.waitForCodeCalls === 0) await Promise.resolve();
    controller.abort(new Error("operator went away"));

    const result = await connecting;
    expect(result.ok).toBe(false);

    const captured = await events();
    expect(captured.map((e) => e.event)).toEqual(["mcp_oauth", "mcp_connect"]);
    expect(captured[0]?.properties.result).toBe("cancelled");
    const body = await wire();
    expect(body).not.toContain("acme");
    expect(body).not.toContain("operator went away");
  });

  test("a provider denial reports cancelled and never ships the denial text", async () => {
    const { telemetry, wire, events } = harness();
    setTelemetry(telemetry);
    mock.connectFailuresLeft = Number.POSITIVE_INFINITY;
    // The provider refuses with its own error text, as a real denial does.
    mock.callbackGate = Promise.reject(
      new Error("Authorization failed: access_denied"),
    );
    // Swallow the unhandled rejection through the gate handle: the wait path
    // observes it via the mocked waitForCode await.
    mock.callbackGate.catch(() => undefined);

    const result = await connectMCPServer(
      { name: SERVER_NAME, type: "http", url: SERVER_URL },
      { onAuthURL: () => undefined },
    );
    expect(result.ok).toBe(false);

    const captured = await events();
    expect(captured.map((e) => e.event)).toEqual(["mcp_oauth", "mcp_connect"]);
    expect(captured[0]?.properties.result).toBe("cancelled");
    const body = await wire();
    expect(body).not.toContain("acme");
    expect(body).not.toContain("access_denied");
  });
});
