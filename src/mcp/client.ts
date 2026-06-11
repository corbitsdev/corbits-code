import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MCPServerConfig } from "../settings.js";
import { createOAuthProvider } from "./oauth-provider.js";
import { startCallbackServer } from "./callback-server.js";

export type MCPTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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

// List the server's tools and wrap the connected client in the MCPClient shape.
async function finishClient(client: Client, serverName: string): Promise<MCPClient> {
  const result = await client.listTools();
  const tools: MCPTool[] = result.tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
  }));

  return {
    serverName,
    tools,
    async call(toolName, args, signal) {
      const result = await client.callTool({ name: toolName, arguments: args }, undefined, { signal });
      const content = result.content;
      if (!Array.isArray(content) || content.length === 0) return "";
      return content
        .map((block) => {
          if (block.type === "text") return block.text;
          return JSON.stringify(block);
        })
        .join("\n");
    },
    async close() {
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
    env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
  };
  if (config.args !== undefined) transportOptions.args = config.args;
  if (options.stderr !== undefined) transportOptions.stderr = options.stderr;

  const client = new Client({ name: "interchange-code", version: "1.0.0" });
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
  const client = new Client({ name: "interchange-code", version: "1.0.0" });

  try {
    try {
      await client.connect(makeTransport());
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      if (options.onAuthURL === undefined) {
        throw new Error("Authorization required but no interactive handler is available.");
      }
      // redirectToAuthorization has already surfaced the URL; wait for the
      // operator to complete consent and the loopback to receive the code.
      const code = await callback.waitForCode(options.signal ?? new AbortController().signal);
      await new StreamableHTTPClientTransport(url, { authProvider }).finishAuth(code);
      await client.connect(makeTransport());
    }
    return { ok: true, client: await finishClient(client, config.name) };
  } catch (err) {
    await client.close().catch(() => undefined);
    return { ok: false, serverName: config.name, error: err instanceof Error ? err.message : String(err) };
  } finally {
    callback.close();
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
