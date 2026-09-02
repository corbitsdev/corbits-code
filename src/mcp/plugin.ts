import type { AgentTool } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import type { PermissionGate } from "../permission/gate.js";
import { gateToolCall } from "../plugins/permission-plugin.js";
import { scrubSecretShapedContent } from "../plugins/tool-result-secret-scrub.js";
import {
  truncateToolResultContent,
  type SpillBlobWriter,
} from "../plugins/result-truncation-plugin.js";
import type { MCPClient } from "./client.js";
import { mcpToolName } from "./tool-name.js";

export interface McpSpillOptions {
  getBlobWriter?: () => SpillBlobWriter | undefined;
  getContextDir?: () => string | undefined;
  excludeToolNames?: readonly string[];
}

// MCP results never reach the posix runner, so the secret-scrub and truncation
// middleware in src/plugins never see them. Apply the same scrub-then-truncate
// order here directly (see buildCorePosixToolPlugins) so a compromised MCP
// server cannot leak credential-shaped strings or flood the transcript.
function sanitizeMcpResultContent(
  content: string,
  spill?: { callId: string; writeBlob: SpillBlobWriter; contextDir?: string },
): Promise<string> {
  return truncateToolResultContent(scrubSecretShapedContent(content), undefined, spill);
}

// Convert a connected client's tools into AgentTools for the dynamic runner used
// by the TUI. These tools live in a separate runner from the posix tool plugin
// chain, so each handler is wrapped with the permission gate directly.
export function mcpClientToAgentTools(
  client: MCPClient,
  gate: PermissionGate,
  spillOptions: McpSpillOptions = {},
): AgentTool[] {
  const { getBlobWriter, getContextDir, excludeToolNames = [] } = spillOptions;
  const excluded = new Set(excludeToolNames);

  return client.tools
    .filter((tool) => !excluded.has(tool.name))
    .map((tool) => ({
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
            const writeBlob = getBlobWriter?.();
            const contextDir = getContextDir?.();
            const spill =
              writeBlob !== undefined
                ? {
                    callId: call.id,
                    writeBlob,
                    ...(contextDir !== undefined ? { contextDir } : {}),
                  }
                : undefined;
            return { callId: call.id, content: await sanitizeMcpResultContent(content, spill) };
          } catch (err) {
            return {
              callId: call.id,
              content: err instanceof Error ? err.message : String(err),
              isError: true,
            };
          }
        }),
    }));
}
