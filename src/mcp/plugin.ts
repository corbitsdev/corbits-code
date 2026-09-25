import type { AgentTool } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import type { PermissionGate } from "../permission/gate.js";
import { gateAgentTools } from "../plugins/permission-plugin.js";
import {
  scrubSecretShapedContent,
  scrubSecretShapedValue,
} from "../plugins/tool-result-secret-scrub.js";
import {
  truncateToolResultContent,
  type SpillBlobWriter,
} from "../plugins/result-truncation-plugin.js";
import type { CompactionArchive } from "../session/compaction-archive.js";
import type {
  MCPClient,
  MCPContentBlock,
  MCPToolResultEnvelope,
} from "./client.js";
import { mcpToolName } from "./tool-name.js";
import { unwrapToolContent } from "./client.js";

export const MCP_RECONNECTING_TOOL_ERROR =
  "MCP server is reconnecting; retry the call once it reports connected.";

/**
 * Stable marker prefixing JSON-serialized `structuredContent` when it is the
 * only payload (or supplements an empty flatten). Lets the model — and log
 * grep — distinguish server-structured data from free text.
 */
export const MCP_STRUCTURED_CONTENT_MARKER = "mcp structured result:";

/** True while the server keeps its tools mounted but cannot execute. */
export function isDegradedMcpState(state: { state: string }): boolean {
  return state.state === "reconnecting";
}

export interface McpSpillOptions {
  getBlobWriter?: () => SpillBlobWriter | undefined;
  getContextDir?: () => string | undefined;
  excludeToolNames?: readonly string[];
  /** Primary-only evidence archive; workers omit this getter. */
  getEvidenceArchive?: () => CompactionArchive | undefined;
}

function applyPolicyToBlocks(blocks: MCPContentBlock[]): MCPContentBlock[] {
  return blocks.map((block) => {
    const next = { ...block };
    if (typeof next.text === "string") {
      next.text = scrubSecretShapedContent(next.text);
    }
    for (const [key, value] of Object.entries(next)) {
      if (key === "type" || key === "text") continue;
      if (typeof value === "string") {
        next[key] = scrubSecretShapedContent(value);
      } else if (value !== null && typeof value === "object") {
        next[key] = scrubSecretShapedValue(value);
      }
    }
    return next;
  });
}

// MCP results never reach the posix runner, so the secret-scrub and truncation
// middleware in src/plugins never see them. Apply the same scrub-then-truncate
// order here directly (see buildCorePosixToolPlugins) so a compromised MCP
// server cannot leak credential-shaped strings or flood the transcript.
function sanitizeMcpResultContent(
  content: string,
  spill?: { callId: string; writeBlob: SpillBlobWriter; contextDir?: string },
): Promise<string> {
  return truncateToolResultContent(
    scrubSecretShapedContent(content),
    undefined,
    spill,
  );
}

export function mcpClientTools(
  client: MCPClient,
  spillOptions: McpSpillOptions = {},
): AgentTool[] {
  const {
    getBlobWriter,
    getContextDir,
    excludeToolNames = [],
    getEvidenceArchive,
  } = spillOptions;
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
      handler: async (
        call: ToolCall,
        signal: AbortSignal,
      ): Promise<ToolResult> => {
        try {
          const envelope: MCPToolResultEnvelope =
            typeof client.callResult === "function"
              ? await client.callResult(tool.name, call.arguments, signal)
              : typeof client.callBlocks === "function"
                ? {
                    blocks: await client.callBlocks(
                      tool.name,
                      call.arguments,
                      signal,
                    ),
                    isError: false,
                  }
                : {
                    blocks: [
                      {
                        type: "text",
                        text: await client.call(
                          tool.name,
                          call.arguments,
                          signal,
                        ),
                      } satisfies MCPContentBlock,
                    ],
                    isError: false,
                  };
          const authorizedBlocks = applyPolicyToBlocks(envelope.blocks);
          const scrubbedStructured =
            envelope.structuredContent === undefined
              ? undefined
              : (scrubSecretShapedValue(envelope.structuredContent) as Record<
                  string,
                  unknown
                >);
          const archive = getEvidenceArchive?.();
          if (archive !== undefined) {
            try {
              await archive.recordAuthorizedPayload({
                kind: "tool_result",
                payload:
                  scrubbedStructured === undefined
                    ? { blocks: authorizedBlocks }
                    : {
                        blocks: authorizedBlocks,
                        structuredContent: scrubbedStructured,
                      },
                callId: call.id,
                provenance: "mcp:post-policy-pre-flatten",
              });
            } catch {
              // Archive write must not fail a successful tool result.
            }
          }
          const flattened = unwrapToolContent(authorizedBlocks);
          const isError = envelope.isError === true;
          const baseContent =
            flattened !== ""
              ? flattened
              : scrubbedStructured !== undefined
                ? `${MCP_STRUCTURED_CONTENT_MARKER}\n${JSON.stringify(scrubbedStructured)}`
                : isError
                  ? `MCP tool ${client.serverName}/${tool.name} reported an error with empty content.`
                  : flattened;
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
          const content = await sanitizeMcpResultContent(baseContent, spill);
          return {
            callId: call.id,
            content,
            ...(isError ? { isError: true as const } : {}),
            ...(scrubbedStructured !== undefined
              ? { detail: scrubbedStructured }
              : {}),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const scrubbed = scrubSecretShapedContent(message);
          const archive = getEvidenceArchive?.();
          if (archive !== undefined) {
            try {
              await archive.recordAuthorizedPayload({
                kind: "tool_result",
                payload: scrubbed,
                callId: call.id,
                provenance: "mcp:error",
              });
            } catch {
              // Archive write must not fail a successful tool result.
            }
          }
          return {
            callId: call.id,
            content: scrubbed,
            isError: true,
          };
        }
      },
    }));
}

// Convert a connected client's tools into AgentTools for the dynamic runner used
// by the TUI. These tools live in a separate runner from the posix tool plugin
// chain, so each handler is wrapped with the permission gate directly.
export function mcpClientToAgentTools(
  client: MCPClient,
  gate: PermissionGate,
  spillOptions: McpSpillOptions = {},
): AgentTool[] {
  return gateAgentTools(mcpClientTools(client, spillOptions), gate);
}
