import { expect, test } from "bun:test";

import { createSubAgentSessionStore } from "./session-store.js";

function startCall(seq: number, callId: string, name: string) {
  return {
    type: "inference.tool_call.start" as const,
    seq,
    data: { name, callId, partial: { text: "" } },
  };
}

test("appendEvent dedups repeated tool_call.start names in toolNames", () => {
  const store = createSubAgentSessionStore();
  const session = store.start({ description: "d", agentId: "a", brief: "b" });

  store.appendEvent(session.id, startCall(1, "call-1", "grep"));
  store.appendEvent(session.id, startCall(2, "call-2", "grep"));
  store.appendEvent(session.id, startCall(3, "call-3", "grep"));

  const stored = store.get(session.id);
  expect(stored?.toolNames).toEqual(["grep"]);
});
