/**
 * MCP surface for the TUI runner: late-connect callbacks, the persisted
 * server catalog updates, and the /mcp host surface (list, add, retry,
 * enable/disable, remove).
 */

import { getLogger } from "@intx/log";
import { resolveMcpServers } from "../../config/index.js";
import {
  isExaMCPPreset,
  type MCPServerConfig,
  type MCPServerSettingsEntry,
  type Settings,
} from "../../config/settings.js";
import {
  persistGlobalHTTPMCPServer,
  persistLocalMCPServerEnabled,
  persistLocalMCPServerRemoved,
  persistMCPServerEnabled,
  persistMCPServerRemoved,
  validateMCPServerName,
  type PersistMCPServerListResult,
} from "../../mcp/add-server.js";
import {
  createExaMCPServerConfig,
  EXA_MCP_SERVER_NAME,
} from "../../mcp/exa.js";
import { openInBrowser } from "../../auth/oauth/browser.js";
import { mergeMcpSurfaceEntries, isBuiltinRow } from "../mcp-list.js";
import { nextMcpCatalog } from "../mcp-catalog.js";
import type { MCPConnectCallbacks } from "../../agent/tools.js";
import { type RunnerServices, type RunnerState } from "./state.js";
import { SETTINGS_DIR_NAME, LOG_NAMESPACE_ROOT } from "../../branding.js";

const tuiLogger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);

export interface McpWiring {
  connectLateMCPServer: (server: MCPServerConfig) => void;
  mcpConnectCallbacks: MCPConnectCallbacks;
  surface: ReturnType<typeof createMcpSurface>;
}

export function wireMcp(
  state: RunnerState,
  services: RunnerServices,
): McpWiring {
  const mcpConnectCallbacks: MCPConnectCallbacks = {
    interactiveAuth: true,
    onStatus: (status) => {
      services.mcpStates.set(status.name, status);
      services.emitter.emit("mcp.status", status);
      if (status.state === "connected") {
        state.connectedMcpServers = [
          ...state.connectedMcpServers.filter(
            (server) => server.name !== status.name,
          ),
          { name: status.name, toolCount: status.tools.length },
        ];
        void state.persistRunSnapshot?.("running");
      }
    },
    // MCP tools register for dispatch but stay blind until tool_search promotes them.
    onToolsChanged: (definitions) =>
      services.directorHolder.instance?.updateToolDefinitions(
        services.computeAdvertised(definitions),
      ),
  };

  const connectLateMCPServer = (server: MCPServerConfig): void => {
    void services.toolset
      .connectMCPServer(
        server,
        mcpConnectCallbacks,
        services.mcpConnectController.signal,
      )
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        tuiLogger.error("Late MCP connect failed: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };
  state.connectLateMCPServer = connectLateMCPServer;

  const persistedMCPServer = (name: string): MCPServerConfig | undefined => {
    const fromConnect = (state.config.mcpServers ?? []).find(
      (server) => server.name === name,
    );
    if (fromConnect !== undefined) return fromConnect;
    const entry = state.configuredMcpEntries.find(
      (server) => server.name === name && !isExaMCPPreset(server),
    );
    if (entry === undefined) return undefined;
    const { enabled: _enabled, ...connect } = entry;
    return connect;
  };

  const applyMcpCatalog = (
    result: Extract<PersistMCPServerListResult, { ok: true }>,
  ): void => {
    const next = nextMcpCatalog({
      source: state.config.mcpServersSource ?? "none",
      result,
      globalServers: state.config.settings?.mcpServers,
    });
    state.configuredMcpEntries = next.overlayEntries;
    state.config = {
      ...state.config,
      ...(next.settings !== undefined ? { settings: next.settings } : {}),
      mcpServerEntries: next.overlayEntries,
      mcpServers: next.mcpServers,
      mcpServersSource: next.mcpServersSource,
    };
    services.toolset.setMcpServersSource(next.mcpServersSource);
  };

  const applyAddedMcpCatalog = (
    entries: MCPServerSettingsEntry[],
    settings: Settings,
  ): void => {
    state.configuredMcpEntries = entries;
    const source = state.config.mcpServersSource ?? "none";
    const nextSource = source === "none" ? "global" : source;
    state.config = {
      ...state.config,
      settings,
      mcpServerEntries: entries,
      mcpServers: resolveMcpServers(entries, undefined),
      mcpServersSource: nextSource,
    };
    services.toolset.setMcpServersSource(nextSource);
  };

  const mcpTransportForEnable = (name: string): MCPServerConfig | undefined => {
    const entry = state.configuredMcpEntries.find(
      (server) => server.name === name,
    );
    if (entry !== undefined) {
      if (isExaMCPPreset(entry)) return createExaMCPServerConfig();
      if (entry.enabled === false) return undefined;
      const { enabled: _enabled, ...connect } = entry;
      return connect;
    }
    if (name === EXA_MCP_SERVER_NAME) return createExaMCPServerConfig();
    return undefined;
  };

  const dropConnectedMcpServer = (name: string): void => {
    state.connectedMcpServers = state.connectedMcpServers.filter(
      (server) => server.name !== name,
    );
    void state.persistRunSnapshot?.("running");
  };

  return {
    connectLateMCPServer,
    mcpConnectCallbacks,
    surface: createMcpSurface(
      state,
      services,
      mcpConnectCallbacks,
      persistedMCPServer,
      applyMcpCatalog,
      applyAddedMcpCatalog,
      mcpTransportForEnable,
      dropConnectedMcpServer,
      connectLateMCPServer,
    ),
  };
}

function createMcpSurface(
  state: RunnerState,
  services: RunnerServices,
  mcpConnectCallbacks: MCPConnectCallbacks,
  persistedMCPServer: (name: string) => MCPServerConfig | undefined,
  applyMcpCatalog: (
    result: Extract<PersistMCPServerListResult, { ok: true }>,
  ) => void,
  applyAddedMcpCatalog: (
    entries: MCPServerSettingsEntry[],
    settings: Settings,
  ) => void,
  mcpTransportForEnable: (name: string) => MCPServerConfig | undefined,
  dropConnectedMcpServer: (name: string) => void,
  connectLateMCPServer: (server: MCPServerConfig) => void,
) {
  return {
    list: () =>
      mergeMcpSurfaceEntries(
        state.configuredMcpEntries,
        services.mcpStates,
        state.config.mcpServers ?? [],
      ),
    openAuthURL: (url: string) => openInBrowser(url),
    subscribe: (listener: () => void) => {
      services.emitter.on("mcp.status", listener);
      return () => services.emitter.off("mcp.status", listener);
    },
    get mcpServersSource() {
      return state.config.mcpServersSource ?? "none";
    },
    addServer: async (name: string, url: string) => {
      const result = await persistGlobalHTTPMCPServer(
        services.globalSettingsWriter,
        name,
        url,
        state.config.mcpServersSource ?? "none",
        services.toolset.hasMCPServer,
      );
      if (!result.ok) {
        const message =
          result.reason === "local-shadow"
            ? `Cannot add a global MCP server while ${SETTINGS_DIR_NAME}/settings.json ` +
              "defines mcpServers; remove that local list and restart first."
            : result.reason === "duplicate" || result.reason === "active"
              ? `An MCP server named "${name.trim()}" already exists or is connecting.`
              : result.reason === "skipped"
                ? "Could not read global settings, so no MCP server was added."
                : result.reason === "invalid-name"
                  ? (validateMCPServerName(name.trim()) ??
                    "Enter a valid server name first.")
                  : "Enter an absolute HTTP(S) URL first.";
        return { ok: false, message };
      }
      applyAddedMcpCatalog(result.settings.mcpServers ?? [], result.settings);
      connectLateMCPServer(result.server);
      return {
        ok: true,
        message: `Added ${result.server.name}; connecting now.`,
      };
    },
    retryServer: async (name: string) => {
      const server = persistedMCPServer(name);
      if (server === undefined) {
        return {
          ok: false,
          message: `No persisted MCP server named "${name}" to retry.`,
        };
      }
      connectLateMCPServer(server);
      return { ok: true, message: `Retrying ${server.name}; connecting now.` };
    },
    setEnabled: async (name: string, enabled: boolean) => {
      const source = state.config.mcpServersSource ?? "none";
      const result =
        source === "local"
          ? await persistLocalMCPServerEnabled(
              services.localSettingsWriter,
              name,
              enabled,
            )
          : await persistMCPServerEnabled(
              services.globalSettingsWriter,
              name,
              enabled,
            );
      if (!result.ok) {
        const verb = enabled ? "enable" : "disable";
        const message =
          result.reason === "skipped"
            ? `Could not read settings, so the MCP server was not ${verb}d.`
            : `No MCP server named "${name}" to ${verb}.`;
        return { ok: false, message };
      }
      applyMcpCatalog(result);
      if (!enabled) {
        await services.toolset.disconnectMCPServer(name, mcpConnectCallbacks);
        dropConnectedMcpServer(name);
        return { ok: true, message: `Disabled ${name}.` };
      }
      const server = mcpTransportForEnable(name);
      if (server !== undefined) connectLateMCPServer(server);
      return { ok: true, message: `Enabled ${name}; connecting now.` };
    },
    removeServer: async (name: string) => {
      if (
        isBuiltinRow(
          name,
          state.configuredMcpEntries.find((entry) => entry.name === name),
          state.config.mcpServers ?? [],
        )
      ) {
        return { ok: false, message: "Built-in Exa cannot be removed." };
      }
      const source = state.config.mcpServersSource ?? "none";
      const result =
        source === "local"
          ? await persistLocalMCPServerRemoved(
              services.localSettingsWriter,
              name,
            )
          : await persistMCPServerRemoved(services.globalSettingsWriter, name);
      if (!result.ok) {
        const message =
          result.reason === "builtin-exa"
            ? "Built-in Exa cannot be removed."
            : result.reason === "skipped"
              ? "Could not read settings, so the MCP server was not removed."
              : `No MCP server named "${name}" to remove.`;
        return { ok: false, message };
      }
      applyMcpCatalog(result);
      await services.toolset.disconnectMCPServer(name, mcpConnectCallbacks);
      services.mcpStates.delete(name);
      dropConnectedMcpServer(name);
      for (const server of state.config.mcpServers ?? []) {
        connectLateMCPServer(server);
      }
      return { ok: true, message: `Removed ${name}.` };
    },
  };
}
