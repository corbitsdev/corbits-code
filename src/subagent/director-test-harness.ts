import type { ReactorAction, ReactorCapabilities } from "@intx/types/runtime";

/**
 * Shared ReactorCapabilities stub for director tests. The action builders
 * return protocol-shaped objects; tests only assert on the resulting
 * decide() actions, never on inference behavior.
 */
export function createTestCapabilities(): ReactorCapabilities {
  return {
    infer: (options) =>
      ({
        type: "infer",
        ...(options !== undefined ? { options } : {}),
      }) as ReactorAction,
    executeTools: (calls, parallel, addToHistory) =>
      ({
        type: "execute_tools",
        calls,
        parallel,
        addToHistory,
      }) as ReactorAction,
    suspend: (gate) => ({ type: "suspend", gate }) as ReactorAction,
    fork: (mode, forkId) => ({ type: "fork", mode, forkId }) as ReactorAction,
    emit: (eventType, data) =>
      ({ type: "emit", eventType, data }) as ReactorAction,
    reply: (content) => ({ type: "reply", content }) as ReactorAction,
    checkpoint: (message = "") =>
      ({ type: "checkpoint", message }) as ReactorAction,
    compact: (compactor, reason) =>
      ({ type: "compact", compactor, reason }) as ReactorAction,
    wait: () => ({ type: "wait" }) as ReactorAction,
    done: () => ({ type: "done" }) as ReactorAction,
  };
}
