import type { Tier } from "../permission/classify.js";
import { isReadOnlyMcpTool, mcpToolName, parseMcpToolName } from "./tool-name.js";

// Subset of MCP ToolAnnotations used for permission tiering (hints from tools/list).
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

export interface McpToolPermissionRegistry {
  setTier: (agentToolName: string, tier: Tier) => void;
  removeToolsForServer: (serverName: string) => void;
  tierFor: (agentToolName: string) => Tier | undefined;
  clear: () => void;
}

export function createMcpToolPermissionRegistry(): McpToolPermissionRegistry {
  const tiers = new Map<string, Tier>();
  return {
    setTier(name, tier) {
      tiers.set(name, tier);
    },
    removeToolsForServer(serverName) {
      for (const key of tiers.keys()) {
        if (parseMcpToolName(key)?.server === serverName) tiers.delete(key);
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

function hasAnnotationHints(annotations: McpToolAnnotations | undefined): boolean {
  if (annotations === undefined) return false;
  return (
    annotations.readOnlyHint !== undefined ||
    annotations.destructiveHint !== undefined ||
    annotations.openWorldHint !== undefined
  );
}

// When the server supplies annotation hints, readOnlyHint drives allow vs ask.
// Empty {} or title-only objects fall back to name-prefix heuristics (list_/get_/save_).
export function tierFromMcpTool(
  annotations: McpToolAnnotations | undefined,
  serverName: string,
  toolName: string,
): Tier {
  if (hasAnnotationHints(annotations)) {
    return annotations!.readOnlyHint === true ? "allow" : "ask";
  }
  return isReadOnlyMcpTool(mcpToolName(serverName, toolName)) ? "allow" : "ask";
}

export function registerMcpClientTools(
  registry: McpToolPermissionRegistry,
  serverName: string,
  tools: readonly { name: string; annotations?: McpToolAnnotations }[],
): void {
  for (const tool of tools) {
    registry.setTier(
      mcpToolName(serverName, tool.name),
      tierFromMcpTool(tool.annotations, serverName, tool.name),
    );
  }
}
