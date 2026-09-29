import type { MCPConnectOptions, MCPTool } from "../src/mcp/client.js";
import type { ResolvedMCPServerConfig } from "../src/mcp/exa.js";
import { createPermissionGate } from "../src/permission/gate.js";
import { withMockedModule } from "./mock-module.js";

/**
 * Union of the connect-mode enums the MCP connect mock fixtures use. Each
 * mode maps onto one branch of the mocked `connectMCPServer` state machine.
 */
export type McpConnectMode =
  | "success"
  | "deferred"
  | "failure"
  | "auth-pending"
  | "auth"
  | "rejected"
  | "missing-fetch";

export interface McpToolCall {
  toolName: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
}

export interface McpConnectMock {
  /** Connect mode consulted by the next `connectMCPServer` call. */
  mode: McpConnectMode;
  connectGeneration: number;
  connectConfigs: ResolvedMCPServerConfig[];
  connectOptions: MCPConnectOptions[];
  closedClients: string[];
  closedGenerations: number[];
  /** Resolves the currently hanging deferred connect, if any. */
  releaseDeferredConnect: (() => void) | undefined;
  /** One-shot transient dial failures consumed before the mode branch. */
  failNextConnects: number;
  transientError: string;
  /** Error message for terminal `failure`-mode connects. */
  failureError: string;
  /**
   * When set, the mock offers this auth URL via `onAuthURL` before the mode
   * branch runs. `auth` mode falls back to `authFallbackURL`.
   */
  authURL: string | null;
  blockOnAuth: boolean;
  authWaitAborts: number;
  authResourceCloses: number;
  /** Server names whose connect never settles until the signal aborts. */
  hangNames: Set<string>;
  connectedTools: MCPTool[];
  toolCallResult: string;
  calls: McpToolCall[];
  /** Restores every field to the factory's per-file defaults. */
  reset(): void;
}

export interface McpConnectMockOptions {
  /**
   * Resolves the tool payload for a successful connect. Defaults to the
   * current `connectedTools` field.
   */
  resolveTools?: (mode: McpConnectMode) => MCPTool[];
  /** Initial `connectedTools` restored by `reset`. */
  initialTools?: MCPTool[];
  /** Initial `failureError` restored by `reset`. */
  failureError?: string;
  /** Initial `toolCallResult` restored by `reset`. */
  toolCallResult?: string;
  /**
   * Deferred connects resolve on the connect signal's abort and report an
   * `aborted` error afterwards. Off when the fixture treats deferred
   * connects as un-abortable.
   */
  abortableDeferred?: boolean;
  /**
   * Successful connects tear the client down when the connect signal aborts
   * after the fact, the way a live Streamable HTTP transport does.
   */
  teardownOnAbort?: boolean;
}

export const linearHttpMcpServer = {
  name: "linear",
  type: "http" as const,
  url: "https://mcp.linear.app/mcp",
};

export function mcpTestPermissionGate() {
  return createPermissionGate({
    approvals: [],
    interactive: false,
    skipPermissions: true,
    reactorGated: false,
  });
}

/**
 * Installs the shared mocked `connectMCPServer` state machine for the rest
 * of the calling test file (via `withMockedModule`) and returns the mutable
 * mock state. Pass `import.meta.resolve` of the client module from the
 * caller so the mock lands on the same resolved path the code under test
 * imports.
 */
export async function installMcpConnectMock(
  clientModulePath: string,
  settings: McpConnectMockOptions = {},
): Promise<McpConnectMock> {
  const failureError = settings.failureError ?? "connection exploded";
  const initialTools = settings.initialTools ?? [];
  const toolCallResult = settings.toolCallResult ?? "ok";
  const resolveTools: (mode: McpConnectMode) => MCPTool[] =
    settings.resolveTools ?? (() => mock.connectedTools);
  const abortableDeferred = settings.abortableDeferred ?? false;
  const teardownOnAbort = settings.teardownOnAbort ?? false;

  const mock: McpConnectMock = {
    mode: "success",
    connectGeneration: 0,
    connectConfigs: [],
    connectOptions: [],
    closedClients: [],
    closedGenerations: [],
    releaseDeferredConnect: undefined,
    failNextConnects: 0,
    transientError: "redial refused",
    failureError,
    authURL: null,
    blockOnAuth: false,
    authWaitAborts: 0,
    authResourceCloses: 0,
    hangNames: new Set<string>(),
    connectedTools: initialTools,
    toolCallResult,
    calls: [],
    reset() {
      mock.mode = "success";
      mock.connectGeneration = 0;
      mock.connectConfigs = [];
      mock.connectOptions = [];
      mock.closedClients.length = 0;
      mock.closedGenerations.length = 0;
      mock.releaseDeferredConnect = undefined;
      mock.failNextConnects = 0;
      mock.transientError = "redial refused";
      mock.failureError = failureError;
      mock.authURL = null;
      mock.blockOnAuth = false;
      mock.authWaitAborts = 0;
      mock.authResourceCloses = 0;
      mock.hangNames.clear();
      mock.connectedTools = initialTools;
      mock.toolCallResult = toolCallResult;
      mock.calls.length = 0;
    },
  };

  await withMockedModule(
    clientModulePath,
    (real: typeof import("../src/mcp/client.js")) => ({
      ...real,
      connectMCPServer: async (
        config: ResolvedMCPServerConfig,
        connectOptions: MCPConnectOptions = {},
      ) => {
        mock.connectConfigs.push(config);
        mock.connectOptions.push(connectOptions);
        const generation = ++mock.connectGeneration;
        const mode = mock.mode;

        if (mode === "auth" || mock.blockOnAuth || mock.authURL !== null) {
          connectOptions.onAuthURL?.(
            config.name,
            mock.authURL ?? "https://auth.test/authorize",
          );
        }
        if (mock.failNextConnects > 0) {
          mock.failNextConnects -= 1;
          return {
            ok: false as const,
            serverName: config.name,
            error: mock.transientError,
          };
        }
        if (mode === "failure") {
          return {
            ok: false as const,
            serverName: config.name,
            error: mock.failureError,
          };
        }
        if (mock.blockOnAuth) {
          await new Promise<void>((resolve) => {
            const onAbort = (): void => {
              mock.authWaitAborts += 1;
              mock.authResourceCloses += 1;
              resolve();
            };
            if (connectOptions.signal?.aborted === true) {
              onAbort();
            } else {
              connectOptions.signal?.addEventListener("abort", onAbort, {
                once: true,
              });
            }
          });
          return {
            ok: false as const,
            serverName: config.name,
            error: "authorization aborted",
          };
        }
        if (mode === "auth-pending") {
          return {
            ok: false as const,
            serverName: config.name,
            error: "timed out waiting for the browser",
            authPending: true,
          };
        }
        if (mode === "deferred" || mock.hangNames.has(config.name)) {
          await new Promise<void>((resolve) => {
            mock.releaseDeferredConnect = resolve;
            if (abortableDeferred) {
              const onAbort = (): void => resolve();
              if (connectOptions.signal?.aborted === true) onAbort();
              else
                connectOptions.signal?.addEventListener("abort", onAbort, {
                  once: true,
                });
            }
          });
          if (abortableDeferred && connectOptions.signal?.aborted === true) {
            return {
              ok: false as const,
              serverName: config.name,
              error: "aborted",
            };
          }
        }
        if (mode === "rejected") throw new Error("transport setup exploded");

        let closed = false;
        const close = async (): Promise<void> => {
          if (closed) return;
          closed = true;
          mock.closedClients.push(config.name);
          mock.closedGenerations.push(generation);
        };
        if (teardownOnAbort && connectOptions.signal !== undefined) {
          const tearDown = (): void => {
            void close();
          };
          if (connectOptions.signal.aborted) tearDown();
          else
            connectOptions.signal.addEventListener("abort", tearDown, {
              once: true,
            });
        }
        return {
          ok: true as const,
          client: {
            serverName: config.name,
            tools: resolveTools(mode),
            call: async (
              toolName: string,
              args: Record<string, unknown>,
              signal: AbortSignal,
            ) => {
              mock.calls.push({ toolName, args, signal });
              return mock.toolCallResult;
            },
            close,
          },
        };
      },
    }),
  );

  return mock;
}
