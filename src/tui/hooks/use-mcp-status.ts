import { useEffect, useState } from "react";
import type { EventEmitter } from "node:events";
import type { MCPServerState } from "../../agent-tools.js";

export type MCPStatusController = {
  // Servers currently awaiting authorization, in arrival order.
  needsAuth: Array<{ name: string; url: string }>;
  // Names of servers that connected successfully.
  connected: string[];
  // Name + tool list, for the /mcp command.
  servers: Array<{ name: string; tools: string[] }>;
};

// Track per-server MCP connection state, fed by "mcp.status" events emitted as
// the background connector progresses. Keyed by server name so a later state for
// the same server replaces the earlier one.
export function useMCPStatus(eventEmitter: EventEmitter): MCPStatusController {
  const [states, setStates] = useState<Map<string, MCPServerState>>(() => new Map());

  useEffect(() => {
    const handler = (state: MCPServerState) => {
      setStates((prev) => {
        const next = new Map(prev);
        next.set(state.name, state);
        return next;
      });
    };
    eventEmitter.on("mcp.status", handler);
    return () => {
      eventEmitter.off("mcp.status", handler);
    };
  }, [eventEmitter]);

  const all = [...states.values()];
  return {
    needsAuth: all.flatMap((s) => (s.state === "needs-auth" ? [{ name: s.name, url: s.url }] : [])),
    connected: all.flatMap((s) => (s.state === "connected" ? [s.name] : [])),
    servers: all.flatMap((s) => (s.state === "connected" ? [{ name: s.name, tools: s.tools }] : [])),
  };
}
