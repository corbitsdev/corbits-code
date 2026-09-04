import type { MCPServerState } from "../agent/tools.js";
import type { MCPServerConfig, MCPServerSettingsEntry } from "../config/settings.js";
import { isExaMCPPreset } from "../config/settings.js";
import { EXA_MCP_SERVER_NAME, isBuiltinExaMCPServer } from "../mcp/exa.js";
import type { McpEntry } from "./command-surfaces.js";

function isConfiguredDisabled(entry: MCPServerSettingsEntry | undefined): boolean {
  return entry?.enabled === false;
}

export function isBuiltinRow(
  name: string,
  entry: MCPServerSettingsEntry | undefined,
  liveServers: readonly MCPServerConfig[],
): boolean {
  if (entry !== undefined) return isExaMCPPreset(entry);
  if (name !== EXA_MCP_SERVER_NAME) return false;
  const live = liveServers.find((server) => server.name === name);
  return live === undefined || isBuiltinExaMCPServer(live);
}

function withBuiltin(entry: McpEntry, builtin: boolean): McpEntry {
  return builtin ? { ...entry, builtin: true } : entry;
}

function liveMcpEntry(status: MCPServerState, builtin: boolean): McpEntry | undefined {
  if (status.state === "disconnected") return undefined;
  switch (status.state) {
    case "connected":
      return withBuiltin(
        { name: status.name, state: "connected", toolCount: status.tools.length },
        builtin,
      );
    case "needs-auth":
      return withBuiltin({ name: status.name, state: "needs-auth", authURL: status.url }, builtin);
    case "failed":
      return withBuiltin({ name: status.name, state: "failed", error: status.error }, builtin);
    case "connecting":
      return withBuiltin({ name: status.name, state: "connecting" }, builtin);
  }
}

/**
 * `/mcp` identity: configured catalog (including disabled, plus implicit builtin
 * Exa when that name is absent) union live names that are not `disconnected`.
 * Configured `enabled === false` wins; leftover live `disconnected` is never painted.
 */
export function mergeMcpSurfaceEntries(
  configured: readonly MCPServerSettingsEntry[],
  live: ReadonlyMap<string, MCPServerState>,
  liveServers: readonly MCPServerConfig[] = [],
): McpEntry[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  if (!configured.some((entry) => entry.name === EXA_MCP_SERVER_NAME)) {
    add(EXA_MCP_SERVER_NAME);
  }
  for (const entry of configured) add(entry.name);
  for (const [name, status] of live) {
    if (status.state !== "disconnected") add(name);
  }

  const byName = new Map(configured.map((entry) => [entry.name, entry]));
  return names.map((name) => {
    const entry = byName.get(name);
    const builtin = isBuiltinRow(name, entry, liveServers);
    if (isConfiguredDisabled(entry)) {
      return withBuiltin({ name, state: "disabled" }, builtin);
    }
    const status = live.get(name);
    if (status !== undefined && status.state !== "disconnected") {
      return liveMcpEntry(status, builtin) ?? withBuiltin({ name, state: "connecting" }, builtin);
    }
    return withBuiltin({ name, state: "connecting" }, builtin);
  });
}
