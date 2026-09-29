import { withMockedModule } from "./mock-module.js";

/**
 * Shared mocked `@modelcontextprotocol/sdk` client scaffolding for the
 * client-auth test suites. Each installer wraps `withMockedModule` for one
 * SDK/product module and forwards behavior to hooks the calling file
 * supplies, so the per-file mocks only describe what their assertions
 * actually observe.
 */

export interface MockAuthProvider {
  redirectToAuthorization?: (url: URL) => void | Promise<void>;
  saveCodeVerifier?: (codeVerifier: string) => void | Promise<void>;
  codeVerifier?: () => string | undefined;
}

export interface McpSdkMockState {
  /** Auth provider of the transport the mocked Client last connected. */
  liveProvider: MockAuthProvider | undefined;
  /** Request signal of the last constructed transport, when present. */
  lastRequestSignal: AbortSignal | undefined;
}

export function createMcpSdkMockState(): McpSdkMockState {
  return { liveProvider: undefined, lastRequestSignal: undefined };
}

/** Shape handed to transport hooks; mirrors the live transport instance. */
export interface MockTransportSelf {
  provider: MockAuthProvider | undefined;
  signal: AbortSignal | null | undefined;
  options:
    | { authProvider?: MockAuthProvider; requestInit?: RequestInit }
    | undefined;
}

export interface McpClientMockHooks {
  connect: (provider: MockAuthProvider | undefined) => Promise<void>;
  listTools: (
    params: unknown,
    options: { signal?: AbortSignal } | undefined,
  ) => Promise<{ tools: [] }>;
  callTool: () => Promise<{ content: [] }>;
  close: () => void | Promise<void>;
}

export interface McpTransportMockHooks {
  construct?: (self: MockTransportSelf) => void;
  finishAuth: (self: MockTransportSelf) => Promise<void>;
  auth?: (self: MockTransportSelf) => Promise<void>;
}

export interface McpCallbackServerMockHooks {
  start?: () => void;
  waitForCode: (signal: AbortSignal | undefined) => Promise<string>;
  close: () => void;
}

export async function mockMcpClientModule(
  state: McpSdkMockState,
  hooks: McpClientMockHooks,
): Promise<void> {
  await withMockedModule(
    import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"),
    (real: typeof import("@modelcontextprotocol/sdk/client/index.js")) => ({
      ...real,
      Client: class {
        async connect(transport?: {
          provider?: MockAuthProvider;
        }): Promise<void> {
          state.liveProvider = transport?.provider;
          await hooks.connect(transport?.provider);
        }
        async listTools(
          params?: unknown,
          options?: { signal?: AbortSignal },
        ): Promise<{ tools: [] }> {
          return hooks.listTools(params, options);
        }
        async callTool(): Promise<{ content: [] }> {
          return hooks.callTool();
        }
        async close(): Promise<void> {
          await hooks.close();
        }
      },
    }),
  );
}

export async function mockMcpTransportModule(
  state: McpSdkMockState,
  hooks: McpTransportMockHooks,
): Promise<void> {
  await withMockedModule(
    import.meta.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    (
      real: typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    ) => ({
      ...real,
      StreamableHTTPClientTransport: class {
        provider?: MockAuthProvider;
        options?:
          | { authProvider?: MockAuthProvider; requestInit?: RequestInit }
          | undefined;
        constructor(
          _url: URL,
          options?: {
            authProvider?: MockAuthProvider;
            requestInit?: RequestInit;
          },
        ) {
          if (options?.authProvider !== undefined)
            this.provider = options.authProvider;
          this.options = options;
          const signal = options?.requestInit?.signal;
          if (signal !== undefined && signal !== null)
            state.lastRequestSignal = signal;
          hooks.construct?.({ provider: this.provider, signal, options });
        }
        async finishAuth(): Promise<void> {
          await hooks.finishAuth({
            provider: this.provider,
            signal: this.options?.requestInit?.signal,
            options: this.options,
          });
        }
        async auth(): Promise<void> {
          await hooks.auth?.({
            provider: this.provider,
            signal: this.options?.requestInit?.signal,
            options: this.options,
          });
        }
        get sessionId(): string | undefined {
          return undefined;
        }
      },
    }),
  );
}

export async function mockMcpCallbackServerModule(
  hooks: McpCallbackServerMockHooks,
): Promise<void> {
  await withMockedModule(
    import.meta.resolve("../src/mcp/callback-server.js"),
    (real: typeof import("../src/mcp/callback-server.js")) => ({
      ...real,
      startCallbackServer: async () => {
        hooks.start?.();
        return {
          redirectUrl: "http://127.0.0.1:12345/callback",
          expectState: () => undefined,
          waitForCode: async (signal: AbortSignal | undefined) =>
            hooks.waitForCode(signal),
          close: () => hooks.close(),
        };
      },
    }),
  );
}

export async function mockMcpOAuthProviderModule<O>(
  create: (options: O) => unknown,
): Promise<void> {
  await withMockedModule(
    import.meta.resolve("../src/mcp/oauth-provider.js"),
    (real: typeof import("../src/mcp/oauth-provider.js")) => ({
      ...real,
      createOAuthProvider: async (options: O) => create(options),
    }),
  );
}
