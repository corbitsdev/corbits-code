import type { Tier } from "../permission/classify.js";
import { isReadOnlyMcpTool } from "./tool-name.js";

// Subset of MCP ToolAnnotations used for permission tiering (hints from tools/list).
export type McpToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
};

export type McpToolPermissionRegistry = {
  setTier: (agentToolName: string, tier: Tier) => void;
  removeToolsForServer: (serverName: string) => void;
  tierFor: (agentToolName: string) => Tier | undefined;
  clear: () => void;
};

export function createMcpToolPermissionRegistry(): McpToolPermissionRegistry {
  const tiers = new Map<string, Tier>();
  return {
    setTier(name, tier) {
      tiers.set(name, tier);
    },
    removeToolsForServer(serverName) {
      const prefix = `mcp__${serverName}__`;
      for (const key of tiers.keys()) {
        if (key.startsWith(prefix)) tiers.delete(key);
      }
    },
    tierFor(name) {
      return tiers.get(name);
    },
    clear() {
      tiers.clear();
    },
  };
}

function mcpAgentToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

// When the server supplies annotations, readOnlyHint drives allow vs ask. Without
// annotations, fall back to name-prefix heuristics (Linear-style list_/get_/save_).
export function tierFromMcpTool(
  annotations: McpToolAnnotations | undefined,
  serverName: string,
  toolName: string,
): Tier {
  if (annotations !== undefined) {
    return annotations.readOnlyHint === true ? "allow" : "ask";
  }
  return isReadOnlyMcpTool(mcpAgentToolName(serverName, toolName)) ? "allow" : "ask";
}

export function registerMcpClientTools(
  registry: McpToolPermissionRegistry,
  serverName: string,
  tools: ReadonlyArray<{ name: string; annotations?: McpToolAnnotations }>,
): void {
  for (const tool of tools) {
    registry.setTier(mcpAgentToolName(serverName, tool.name), tierFromMcpTool(tool.annotations, serverName, tool.name));
  }
}