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

describe("CL-820: filesRead tracking", () => {
  test("filesRead starts empty on new director", () => {
    const director = createCodingDirector("", [], 30);
    expect(director.getState().filesRead).toEqual([]);
  });

  test("reading a file adds its path to filesRead", async () => {
    const director = createCodingDirector("", [], 30);
    const callId = "call-r1";
    await director.decide(makeInferenceDoneEvent([{ id: callId, name: "read_file", args: { path: "src/foo.ts" } }]), mockState, mockCapabilities);
    await director.decide(makeToolDoneEvent(callId), mockState, mockCapabilities);
    expect(director.getState().filesRead!.some((e) => e.path === "src/foo.ts")).toBe(true);
  });

  test("list_dir does not add to filesRead", async () => {
    const director = createCodingDirector("", [], 30);
    const callId = "call-ld";
    await director.decide(makeInferenceDoneEvent([{ id: callId, name: "list_dir", args: { path: "src/" } }]), mockState, mockCapabilities);
    await director.decide(makeToolDoneEvent(callId), mockState, mockCapabilities);
    expect(director.getState().filesRead).toEqual([]);
  });

  test("filesRead is restored on setState (simulates resume)", () => {
    const director = createCodingDirector("", [], 30);
    director.setState({
      turnsUsed: 2,
      submitCalled: false,
      callIdToName: {},
      idleCycles: 0,
      planSubmitted: false,
      plan: [],
      filesRead: [{ path: "src/foo.ts", turn: 1 }],
    });
    expect(director.getState().filesRead!.some((e) => e.path === "src/foo.ts")).toBe(true);
  });

  test("filesRead is empty on fresh director (not restored from prior state)", () => {
    const director = createCodingDirector("", [], 30);
    expect(director.getState().filesRead).toEqual([]);
  });

  test("getFilesReadAtTurn exposes path-to-turn map", async () => {
    const director = createCodingDirector("", [], 30);
    const callId = "call-r2";
    await director.decide(makeInferenceDoneEvent([{ id: callId, name: "read_file", args: { path: "src/bar.ts" } }]), mockState, mockCapabilities);
    await director.decide(makeToolDoneEvent(callId), mockState, mockCapabilities);
    expect(director.getFilesReadAtTurn().has("src/bar.ts")).toBe(true);
  });
});

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
