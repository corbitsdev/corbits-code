import type { ToolPlugin, ExtraTool } from "@intx/tools-posix";
import type { AgentTool } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import type { PermissionGate } from "../permission/gate.js";
import { gateToolCall } from "../plugins/permission-plugin.js";
import type { MCPClient } from "./client.js";

function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

// Convert a connected client's tools into AgentTools for the dynamic runner used
// by the TUI. Unlike createMCPPlugin (which registers into the posix runner and
// inherits its permission middleware), these tools live in a separate runner, so
// each handler is wrapped with the permission gate directly.
export function mcpClientToAgentTools(client: MCPClient, gate: PermissionGate): AgentTool[] {
  return client.tools.map((tool) => ({
    kind: "full" as const,
    definition: {
      name: mcpToolName(client.serverName, tool.name),
      description: `[${client.serverName}] ${tool.description}`,
      inputSchema: tool.inputSchema,
    },
    handler: (call: ToolCall, signal: AbortSignal): Promise<ToolResult> =>
      gateToolCall(gate, call, signal, async () => {
        try {
          const content = await client.call(tool.name, call.arguments, signal);
          return { callId: call.id, content };
        } catch (err) {
          return { callId: call.id, content: err instanceof Error ? err.message : String(err), isError: true };
        }
      }),
  }));
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
