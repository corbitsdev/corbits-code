/**
 * Shared reactor stubs for director-level tests: an empty state, pass-through
 * capabilities that return the action literal each method names, and the
 * canonical content-only assistant turn used to probe open-task nudges.
 */
import type {
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
  ReactorState,
} from "@intx/types/runtime";

/** Empty reactor state for decides that never read it. */
export const stubReactorState = {} as unknown as ReactorState;

/** Pass-through capabilities: every method returns its action literal. */
export const stubReactorCapabilities: ReactorCapabilities = {
  infer: (options) =>
    ({
      type: "infer",
      ...(options !== undefined ? { options } : {}),
    }) as ReactorAction,
  executeTools: (calls) => ({ type: "execute_tools", calls }),
  suspend: (gate) => ({ type: "suspend", gate }),
  fork: (mode, forkId) => ({ type: "fork", mode, forkId }),
  emit: (eventType, data) => ({ type: "emit", eventType, data }),
  reply: (content) => ({ type: "reply", content }),
  checkpoint: (message = "") => ({ type: "checkpoint", message }),
  compact: (compactor, reason) => ({ type: "compact", compactor, reason }),
  wait: () => ({ type: "wait" }),
  done: () => ({ type: "done" }),
};

/** A content-only assistant turn ("all set") — the canonical nudge probe. */
export function stubTextTurnEvent(): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      model: "test",
      timestamp: 0,
      content: [{ type: "text", text: "all set" }],
    },
    usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    source: { model: "test-model" },
  } as unknown as ReactorInboundEvent;
}
