import { withMockedModule } from "./mock-module.js";

/**
 * Shared mocked `@modelcontextprotocol/sdk` client scaffolding for the
 * client-auth test suites. Each installer wraps `withMockedModule` for one
 * SDK/product module and forwards behavior to hooks the calling file
 * supplies, so per-file mocks describe only what their assertions observe.
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
  /** Identity of the StreamableHTTPClientTransport instance. */
  instanceId: number;
  resourceMetadataUrl?: string;
  scope?: string;
  sessionId?: string;
}

export interface MockLiveTransport {
  provider?: MockAuthProvider;
  instanceId: number;
  resourceMetadataUrl?: string;
  scope?: string;
  sessionId?: string;
}

function transportSnapshot(self: {
  provider?: MockAuthProvider;
  options?:
    | { authProvider?: MockAuthProvider; requestInit?: RequestInit }
    | undefined;
  instanceId: number;
  resourceMetadataUrl?: string;
  scope?: string;
  sessionId?: string;
}): MockTransportSelf {
  return {
    provider: self.provider,
    signal: self.options?.requestInit?.signal,
    options: self.options,
    instanceId: self.instanceId,
    ...(self.resourceMetadataUrl !== undefined
      ? { resourceMetadataUrl: self.resourceMetadataUrl }
      : {}),
    ...(self.scope !== undefined ? { scope: self.scope } : {}),
    ...(self.sessionId !== undefined ? { sessionId: self.sessionId } : {}),
  };
}

export interface McpClientMockHooks {
  connect: (
    provider: MockAuthProvider | undefined,
    transport?: MockLiveTransport,
  ) => Promise<void>;
  listTools: (
    params: unknown,
    options: { signal?: AbortSignal } | undefined,
  ) => Promise<{ tools: [] }>;
  callTool: (sessionId?: string) => Promise<{ content: [] }>;
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
        #transport: MockLiveTransport | undefined = undefined;

        get transport(): MockLiveTransport | undefined {
          return this.#transport;
        }

        async connect(transport?: MockLiveTransport): Promise<void> {
          this.#transport = transport;
          state.liveProvider = transport?.provider;
          await hooks.connect(transport?.provider, transport);
        }
        async listTools(
          params?: unknown,
          options?: { signal?: AbortSignal },
        ): Promise<{ tools: [] }> {
          return hooks.listTools(params, options);
        }
        async callTool(): Promise<{ content: [] }> {
          return hooks.callTool(this.#transport?.sessionId);
        }
        async close(): Promise<void> {
          this.#transport = undefined;
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
  let nextTransportId = 1;
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
        readonly instanceId: number;
        resourceMetadataUrl?: string;
        scope?: string;
        sessionId?: string;
        constructor(
          _url: URL,
          options?: {
            authProvider?: MockAuthProvider;
            requestInit?: RequestInit;
          },
        ) {
          this.instanceId = nextTransportId;
          nextTransportId += 1;
          if (options?.authProvider !== undefined)
            this.provider = options.authProvider;
          this.options = options;
          const signal = options?.requestInit?.signal;
          if (signal !== undefined && signal !== null)
            state.lastRequestSignal = signal;
          hooks.construct?.(transportSnapshot(this));
        }
        async finishAuth(): Promise<void> {
          await hooks.finishAuth(transportSnapshot(this));
        }
        async auth(): Promise<void> {
          await hooks.auth?.(transportSnapshot(this));
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
