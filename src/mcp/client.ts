import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { MCPServerConfig } from "../settings.js";

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

export async function connectMCPServer(
  config: MCPServerConfig,
  options?: { stderr?: "inherit" | "ignore" | "pipe" },
): Promise<MCPConnectResult> {
  const transportOptions: { command: string; args?: string[]; env?: Record<string, string>; stderr?: "inherit" | "ignore" | "pipe" } = {
    command: config.command,
    env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
  };
  if (config.args !== undefined) transportOptions.args = config.args;
  if (options?.stderr !== undefined) transportOptions.stderr = options.stderr;
  const transport = new StdioClientTransport(transportOptions);

  const client = new Client({ name: "interchange-code", version: "1.0.0" });

  try {
    await client.connect(transport);
  } catch (err) {
    return {
      ok: false,
      serverName: config.name,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let toolList: MCPTool[];
  try {
    const result = await client.listTools();
    toolList = result.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    }));
  } catch (err) {
    await client.close().catch(() => undefined);
    return {
      ok: false,
      serverName: config.name,
      error: `Failed to list tools: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const mcpClient: MCPClient = {
    serverName: config.name,
    tools: toolList,

    async call(toolName, args, signal) {
      const abortPromise = new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });

      const callPromise = client.callTool({ name: toolName, arguments: args });
      const result = await Promise.race([callPromise, abortPromise]);

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

  return { ok: true, client: mcpClient };
}

export async function connectMCPServers(
  configs: MCPServerConfig[],
  onWarning: (message: string) => void,
  options?: { stderr?: "inherit" | "ignore" | "pipe" },
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
