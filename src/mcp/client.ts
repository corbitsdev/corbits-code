import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MCPServerConfig } from "../config/settings.js";
import { createOAuthProvider, type IntercodeOAuthProvider } from "./oauth-provider.js";
import { startCallbackServer, type CallbackServer } from "./callback-server.js";
import type { McpToolAnnotations } from "./tool-permissions.js";
import { buildStdioMcpProcessEnv } from "./stdio-env.js";

export type MCPTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
};

export type MCPClient = {
  serverName: string;
  tools: MCPTool[];
  call(toolName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
};

export type MCPConnectResult =
  | { ok: true; client: MCPClient }
  | { ok: false; serverName: string; error: string };

export type MCPConnectOptions = {
  stderr?: "inherit" | "ignore" | "pipe";
  // Invoked for http servers when interactive authorization is required, with the
  // URL the operator should open. Absence means non-interactive only.
  onAuthURL?: (serverName: string, authorizationUrl: string) => void;
  // Aborts an in-progress authorization wait (e.g. session shutdown).
  signal?: AbortSignal;
};

function isHttpServer(config: MCPServerConfig): boolean {
  return config.type === "http" || (config.type === undefined && config.url !== undefined);
}

// Flatten an MCP tool result's content array into a single string. Text blocks
// contribute their text; any other block (image, resource, ...) is stringified
// rather than dropped, so a non-text or empty payload never becomes "undefined"
// or throws downstream. This is the boundary where the MCP envelope is removed:
// callers (and the TUI formatter) see plain text/JSON, never the content array.
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

type HTTPAuthContext = {
  url: URL;
  authProvider: IntercodeOAuthProvider;
  callback: CallbackServer;
  signal?: AbortSignal;
  interactive: boolean;
};

function isRecoverableAuthError(err: unknown): boolean {
  return err instanceof UnauthorizedError || err instanceof OAuthError;
}

async function completeInteractiveAuth(context: HTTPAuthContext): Promise<void> {
  if (!context.interactive) throw new Error("Authorization required but no interactive handler is available.");
  const code = await context.callback.waitForCode(context.signal ?? new AbortController().signal);
  await new StreamableHTTPClientTransport(context.url, { authProvider: context.authProvider }).finishAuth(code);
}

async function recoverHTTPAuthorization<T>(
  err: unknown,
  context: HTTPAuthContext | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (context === undefined || !isRecoverableAuthError(err)) throw err;

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

async function withHTTPAuthorizationRecovery<T>(
  context: HTTPAuthContext | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    return recoverHTTPAuthorization(err, context, operation);
  }
}

// List the server's tools and wrap the connected client in the MCPClient shape.
async function finishClient(client: Client, serverName: string, authContext?: HTTPAuthContext): Promise<MCPClient> {
  const result = await withHTTPAuthorizationRecovery(authContext, () => client.listTools());
  const tools: MCPTool[] = result.tools.map((t) => {
    const annotations = t.annotations as McpToolAnnotations | undefined;
    const tool: MCPTool = {
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    };
    if (annotations !== undefined) tool.annotations = annotations;
    return tool;
  });

  return {
    serverName,
    tools,
    async call(toolName, args, signal) {
      const context = authContext === undefined ? undefined : { ...authContext, signal };
      const result = await withHTTPAuthorizationRecovery(context, () =>
        client.callTool({ name: toolName, arguments: args }, undefined, { signal }),
      );
      return unwrapToolContent(result.content);
    },
    async close() {
      authContext?.callback.close();
      await client.close().catch(() => undefined);
    },
  };
}

async function connectStdio(config: MCPServerConfig, options: MCPConnectOptions): Promise<MCPConnectResult> {
  if (config.command === undefined) {
    return { ok: false, serverName: config.name, error: "stdio MCP server requires a command" };
  }
  const transportOptions: { command: string; args?: string[]; env?: Record<string, string>; stderr?: "inherit" | "ignore" | "pipe" } = {
    command: config.command,
    env: buildStdioMcpProcessEnv(process.env, config.env),
  };
  if (config.args !== undefined) transportOptions.args = config.args;
  if (options.stderr !== undefined) transportOptions.stderr = options.stderr;

  const client = new Client({ name: "intercode", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport(transportOptions));
    return { ok: true, client: await finishClient(client, config.name) };
  } catch (err) {
    await client.close().catch(() => undefined);
    return { ok: false, serverName: config.name, error: err instanceof Error ? err.message : String(err) };
  }
}

async function connectHttp(config: MCPServerConfig, options: MCPConnectOptions): Promise<MCPConnectResult> {
  if (config.url === undefined) {
    return { ok: false, serverName: config.name, error: "http MCP server requires a url" };
  }
  const url = new URL(config.url);
  const callback = await startCallbackServer();
  const authProvider = await createOAuthProvider({
    serverName: config.name,
    redirectUrl: callback.redirectUrl,
    onAuthURL: (name, authUrl) => options.onAuthURL?.(name, authUrl),
  });

  // The SDK declares StreamableHTTPClientTransport.sessionId as `string | undefined`,
  // which trips exactOptionalPropertyTypes against Transport's `sessionId?: string`.
  // The transport satisfies the interface at runtime; cast at the boundary.
  const makeTransport = (): Transport =>
    new StreamableHTTPClientTransport(url, { authProvider }) as unknown as Transport;
  const client = new Client({ name: "intercode", version: "1.0.0" });
  const authContext: HTTPAuthContext = {
    url,
    authProvider,
    callback,
    interactive: options.onAuthURL !== undefined,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };

  try {
    await withHTTPAuthorizationRecovery(authContext, () => client.connect(makeTransport()));
    return { ok: true, client: await finishClient(client, config.name, authContext) };
  } catch (err) {
    await client.close().catch(() => undefined);
    callback.close();
    return { ok: false, serverName: config.name, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function connectMCPServer(
  config: MCPServerConfig,
  options: MCPConnectOptions = {},
): Promise<MCPConnectResult> {
  return isHttpServer(config) ? connectHttp(config, options) : connectStdio(config, options);
}

export async function connectMCPServers(
  configs: MCPServerConfig[],
  onWarning: (message: string) => void,
  options: MCPConnectOptions = {},
): Promise<MCPClient[]> {
  const results = await Promise.all(configs.map((c) => connectMCPServer(c, options)));
  const clients: MCPClient[] = [];
  for (const result of results) {
    if (result.ok) {
      clients.push(result.client);
    } else {
      onWarning(`[mcp] Warning: failed to connect to MCP server "${result.serverName}": ${result.error}`);
    }
  }
  return clients;
}
