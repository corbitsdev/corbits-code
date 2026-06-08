import type { ToolPlugin, ExtraTool } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import type { MCPClient } from "./client.js";

function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

function makeExtraTool(client: MCPClient, tool: MCPClient["tools"][number]): ExtraTool {
  const name = mcpToolName(client.serverName, tool.name);
  return {
    definition: {
      name,
      description: `[${client.serverName}] ${tool.description}`,
      inputSchema: tool.inputSchema,
    },
    handler: async (call: ToolCall, signal: AbortSignal): Promise<ToolResult> => {
      try {
        const content = await client.call(tool.name, call.arguments, signal);
        return { callId: call.id, content };
      } catch (err) {
        return {
          callId: call.id,
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  };
}

export type MCPPluginResult = {
  plugin: ToolPlugin;
  connectedServers: string[];
};

export function createMCPPlugin(clients: MCPClient[]): MCPPluginResult {
  const tools: ExtraTool[] = clients.flatMap((client) =>
    client.tools.map((tool) => makeExtraTool(client, tool)),
  );

  const plugin: ToolPlugin = {
    tools,
    async dispose() {
      await Promise.all(clients.map((c) => c.close()));
    },
  };

  return {
    plugin,
    connectedServers: clients.map((c) => c.serverName),
  };
}
