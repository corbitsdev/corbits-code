import { defineTool, type AnnotatedToolFactory } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { connectHostedMcpServer, type McpConnection } from "./connect.js";

export type McpToolPackageConfig = {
  /** Package-namespaced id, e.g. "@corbits/linear-mcp/linear". */
  readonly id: string;
  /** Human-readable server name; also used as the OAuth token-store key. */
  readonly serverName: string;
  /** Hosted MCP endpoint, e.g. "https://mcp.linear.app/mcp". */
  readonly url: string;
  /**
   * Static tool definitions this package declares. The pinned
   * `@intx/agent` this package builds against exposes tool definitions
   * only on the constructed `ToolBundle`, not as pre-construction
   * factory metadata -- so these are set once, synchronously, in
   * `factory()`, before any connection exists. See the package README
   * for the tradeoff this implies when the upstream server's real tool
   * list changes: a removed tool fails at call time with the server's
   * own "unknown tool" error; a newly added tool is invisible until
   * this list is updated and republished.
   */
  readonly toolDeclarations: readonly ToolDefinition[];
  /**
   * Optional environment variable holding a credential the server
   * accepts (e.g. an API key that raises rate limits). Never required:
   * when unset, the URL is used exactly as given. When set, its value
   * is appended as `apiKeyQueryParam` on the connection URL -- the
   * mechanism the hosted server documents for optional keys.
   */
  readonly apiKeyEnvVar?: string;
  /** Query parameter name the server expects the optional key under. */
  readonly apiKeyQueryParam?: string;
  /** Name reported to the MCP server and used in the OAuth client_name. */
  readonly clientName: string;
};

// Builds an AnnotatedToolFactory for a hosted MCP server. The returned
// bundle's `definitions` are set synchronously and statically inside
// `factory()`, with no I/O; the real connection -- and any OAuth flow it
// requires -- happens lazily inside the bundle's `run()`, on first call.
export function defineMcpToolFactory(config: McpToolPackageConfig): AnnotatedToolFactory {
  return defineTool({
    id: config.id,
    factory: () => {
      let connection: McpConnection | undefined;
      let connecting: Promise<McpConnection> | undefined;
      let pendingAuthURL: string | undefined;

      const connectUrl = ((): string => {
        const apiKey = config.apiKeyEnvVar !== undefined ? process.env[config.apiKeyEnvVar] : undefined;
        if (apiKey === undefined || config.apiKeyQueryParam === undefined) return config.url;
        const withKey = new URL(config.url);
        withKey.searchParams.set(config.apiKeyQueryParam, apiKey);
        return withKey.toString();
      })();

      let disposed = false;

      const ensureConnected = async (signal: AbortSignal): Promise<McpConnection> => {
        if (connection !== undefined) return connection;
        if (connecting === undefined) {
          connecting = connectHostedMcpServer(config.serverName, connectUrl, {
            clientName: config.clientName,
            signal,
            onAuthURL: (_name, url) => {
              pendingAuthURL = url;
            },
          }).then(
            (result) => {
              connection = result;
              // A dispose() that raced this connect while it was still in
              // flight had nothing to close yet; close it now so a
              // connection that resolves after teardown does not leak its
              // transport and callback server.
              if (disposed) void result.close();
              return result;
            },
            (err: unknown) => {
              // Clear the cached rejection so the next run() retries the
              // connection instead of replaying a stale failure forever --
              // the underlying cause (network blip, user completing OAuth
              // through a channel we didn't observe) may no longer hold.
              connecting = undefined;
              throw err;
            },
          );
        }
        return connecting;
      };

      return {
        definitions: config.toolDeclarations.map((decl) => ({ ...decl })),
        async run(call, signal) {
          pendingAuthURL = undefined;
          let client: McpConnection;
          try {
            // The first connect on a hosted, OAuth-protected server blocks
            // this call until the browser round-trip completes (or fails)
            // -- there is no way to hand control back to the caller mid-
            // authorization and resume later. Wiring the tool call's own
            // signal through means the caller can still bound or cancel
            // that wait instead of it hanging indefinitely; `onAuthURL`
            // additionally records the URL so a signal-driven abort still
            // reports where to authorize.
            client = await ensureConnected(signal);
          } catch (err) {
            if (pendingAuthURL !== undefined) {
              return {
                callId: call.id,
                content: `Authorization required. Open this URL to connect ${config.serverName}: ${pendingAuthURL}`,
                isError: true,
              };
            }
            return {
              callId: call.id,
              content: err instanceof Error ? err.message : String(err),
              isError: true,
            };
          }
          try {
            const text = await client.call(call.name, call.arguments, signal);
            return { callId: call.id, content: text, isError: false };
          } catch (err) {
            return {
              callId: call.id,
              content: err instanceof Error ? err.message : String(err),
              isError: true,
            };
          }
        },
        async dispose() {
          disposed = true;
          await connection?.close();
        },
      };
    },
  });
}
