import { beforeEach, describe, expect, test } from "bun:test";
import { withMockedModule } from "../../tests/helpers/mock-module.js";

let callbackStarts = 0;
let providerCreates = 0;
let transportOptions: unknown[] = [];
let providerServerURL: string | undefined;
let clientConnectError: Error | undefined;

const authProvider = { resetAuthorization: async () => undefined };

await withMockedModule(
  import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"),
  (real: typeof import("@modelcontextprotocol/sdk/client/index.js")) => ({
    ...real,
    Client: class {
      async connect(): Promise<void> {
        if (clientConnectError !== undefined) throw clientConnectError;
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
      constructor(_url: URL, options?: unknown) {
        transportOptions.push(options);
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
        close: () => undefined,
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
      return authProvider;
    },
  }),
);

const { connectMCPServer } = await import("./client.js");

describe("HTTP MCP auth policy", () => {
  beforeEach(() => {
    callbackStarts = 0;
    providerCreates = 0;
    transportOptions = [];
    providerServerURL = undefined;
    clientConnectError = undefined;
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
