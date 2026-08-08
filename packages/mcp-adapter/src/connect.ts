import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { createOAuthProvider, type McpOAuthProvider } from "./oauth-provider.js";
import { startCallbackServer, type CallbackServer } from "./callback-server.js";

export type McpTool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type McpConnection = {
  serverName: string;
  tools: McpTool[];
  call(toolName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
};

export type ConnectOptions = {
  onAuthURL: (serverName: string, authorizationUrl: string) => void;
  clientName: string;
  home?: string;
  signal?: AbortSignal;
};

export function unwrapToolContent(content: unknown): string {
  if (!Array.isArray(content) || content.length === 0) return "";
  return content
    .map((block) => {
      if (block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        return String((block as { text?: unknown }).text ?? "");
      }
      return JSON.stringify(block);
    })
    .join("\n");
}

type AuthContext = { url: URL; authProvider: McpOAuthProvider; callback: CallbackServer; signal?: AbortSignal };

function isRecoverableAuthError(err: unknown): boolean {
  return err instanceof UnauthorizedError || err instanceof OAuthError;
}

async function completeInteractiveAuth(context: AuthContext): Promise<void> {
  const code = await context.callback.waitForCode(context.signal ?? new AbortController().signal);
  await new StreamableHTTPClientTransport(context.url, { authProvider: context.authProvider }).finishAuth(code);
}

async function recoverAuthorization<T>(err: unknown, context: AuthContext, operation: () => Promise<T>): Promise<T> {
  if (!isRecoverableAuthError(err)) throw err;
  let lastErr: unknown = err;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (lastErr instanceof OAuthError) await context.authProvider.resetAuthorization();
    if (lastErr instanceof UnauthorizedError) {
      await completeInteractiveAuth(context);
      return operation();
    }
    try {
      return await operation();
    } catch (nextErr) {
      if (!isRecoverableAuthError(nextErr)) throw nextErr;
      lastErr = nextErr;
    }
  }
  throw lastErr;
}

async function withAuthRecovery<T>(context: AuthContext, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    return recoverAuthorization(err, context, operation);
  }
}

// Connects to a hosted, OAuth-protected MCP server over streamable HTTP.
// Owns its own callback server and OAuth provider end to end -- nothing
// here depends on being driven by a TUI; the caller only supplies where
// to surface the authorization URL.
export async function connectHostedMcpServer(
  serverName: string,
  url: string,
  options: ConnectOptions,
): Promise<McpConnection> {
  const target = new URL(url);
  const callback = await startCallbackServer(serverName);
  const authProvider = await createOAuthProvider({
    clientName: options.clientName,
    serverName,
    redirectUrl: callback.redirectUrl,
    onAuthURL: options.onAuthURL,
    onAuthorizationState: callback.expectState,
    ...(options.home !== undefined ? { home: options.home } : {}),
  });
  const authContext: AuthContext = {
    url: target,
    authProvider,
    callback,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  const client = new Client({ name: options.clientName, version: "1.0.0" });
  try {
    await withAuthRecovery(authContext, () =>
      client.connect(new StreamableHTTPClientTransport(target, { authProvider }) as never),
    );
    const result = await withAuthRecovery(authContext, () => client.listTools());
    const tools: McpTool[] = result.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    }));
    return {
      serverName,
      tools,
      async call(toolName, args, signal) {
        const context = { ...authContext, signal };
        const result = await withAuthRecovery(context, () =>
          client.callTool({ name: toolName, arguments: args }, undefined, { signal }),
        );
        return unwrapToolContent(result.content);
      },
      async close() {
        callback.close();
        await client.close().catch(() => undefined);
      },
    };
  } catch (err) {
    await client.close().catch(() => undefined);
    callback.close();
    throw err;
  }
}
