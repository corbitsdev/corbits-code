import type { MCPServerConfig } from "../config/settings.js";

export const EXA_MCP_SERVER_NAME = "exa";
export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

export interface ResolvedMCPServerConfig extends MCPServerConfig {
  oauth?: false;
  source?: "builtin";
}

export function createExaMCPServerConfig(): ResolvedMCPServerConfig {
  return {
    name: EXA_MCP_SERVER_NAME,
    type: "http",
    url: EXA_MCP_URL,
    oauth: false,
    source: "builtin",
  };
}

export function isBuiltinExaMCPServer(config: MCPServerConfig): boolean {
  return (
    config.name === EXA_MCP_SERVER_NAME && (config as ResolvedMCPServerConfig).source === "builtin"
  );
}
