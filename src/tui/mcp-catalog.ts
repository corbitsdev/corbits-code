import { resolveMcpServers } from "../config/index.js";
import type { MCPServerSettingsEntry, Settings } from "../config/settings.js";
import type { PersistMCPServerListResult } from "../mcp/add-server.js";

export interface McpCatalogApplyInput {
  source: "local" | "global" | "none";
  result: Extract<PersistMCPServerListResult, { ok: true }>;
  globalServers: MCPServerSettingsEntry[] | undefined;
}

export interface McpCatalogApply {
  overlayEntries: MCPServerSettingsEntry[];
  mcpServers: ReturnType<typeof resolveMcpServers>;
  mcpServersSource: "local" | "global" | "none";
  settings?: Settings;
}

export function nextMcpCatalog(input: McpCatalogApplyInput): McpCatalogApply {
  const { source, result, globalServers } = input;
  if (source === "local") {
    if (result.omitted) {
      return {
        overlayEntries: globalServers ?? [],
        mcpServers: resolveMcpServers(globalServers, undefined),
        mcpServersSource: globalServers !== undefined ? "global" : "none",
      };
    }
    return {
      overlayEntries: result.entries,
      mcpServers: resolveMcpServers(globalServers, result.entries),
      mcpServersSource: "local",
    };
  }
  return {
    overlayEntries: result.entries,
    mcpServers: resolveMcpServers(result.entries, undefined),
    mcpServersSource: source === "none" ? "global" : source,
    ...(result.settings !== undefined ? { settings: result.settings } : {}),
  };
}
