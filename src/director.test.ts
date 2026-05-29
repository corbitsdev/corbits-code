import { describe, test, expect } from "bun:test";
import { createCodingDirector } from "./director.js";
import type { ReactorState, ReactorCapabilities, ReactorAction, ReactorInboundEvent } from "@intx/types/runtime";

const mockState: ReactorState = {} as unknown as ReactorState;

const mockCapabilities: ReactorCapabilities = {
  infer: () => ({ type: "infer" }),
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

function makeInferenceDoneEvent(toolCalls: Array<{ id: string; name: string; args?: Record<string, unknown> }>) {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      model: "test",
      timestamp: 0,
      content: toolCalls.map((tc) => ({
        type: "tool_call",
        id: tc.id,
        name: tc.name,
        arguments: tc.args ?? {},
      })),
    },
    usage: { input: 0, output: 0 },
    source: "test",
  } as unknown as ReactorInboundEvent;
}

function makeToolDoneEvent(callId: string) {
  return {
    type: "tool.done",
    result: { callId, content: "ok" },
  } as unknown as ReactorInboundEvent;
}

function actionsArray(result: ReactorAction | ReactorAction[]): ReactorAction[] {
  return Array.isArray(result) ? result : [result];
}

describe("CL-822: consecutive-reads cap removed", () => {
  test("consecutiveReads field is absent from persisted state", () => {
    const director = createCodingDirector("", [], 30);
    const state = director.getState();
    expect("consecutiveReads" in state).toBe(false);
  });

  test("director does not abort after 8 consecutive read_file calls", async () => {
    const director = createCodingDirector("", [], 30);

    for (let i = 1; i <= 8; i++) {
      const callId = `call-${i}`;
      await director.decide(
        makeInferenceDoneEvent([{ id: callId, name: "read_file", args: { path: `file${i}.ts` } }]),
        mockState,
        mockCapabilities,
      );
      const result = await director.decide(makeToolDoneEvent(callId), mockState, mockCapabilities);
      const actions = actionsArray(result);
      const aborted = actions.some(
        (a) => a.type === "done" || (a.type === "reply" && "content" in a && String(a.content).includes("stalled")),
      );
      expect(aborted).toBe(false);
    }
  });
});
