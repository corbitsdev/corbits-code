import { describe, test, expect } from "bun:test";
import { createChatDirector, createCodingDirector } from "./director.js";
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

function makeToolErrorEvent(callId: string, content: string) {
  return {
    type: "tool.done",
    result: { callId, content, isError: true },
  } as unknown as ReactorInboundEvent;
}

function actionsArray(result: ReactorAction | ReactorAction[]): ReactorAction[] {
  return Array.isArray(result) ? result : [result];
}

describe("filesRead tracking", () => {
  test("filesRead starts empty on new director", () => {
    const director = createCodingDirector("", []);
    expect(director.getState().filesRead).toEqual([]);
  });

  test("reading a file adds its path to filesRead", async () => {
    const director = createCodingDirector("", []);
    const callId = "call-r1";
    await director.decide(makeInferenceDoneEvent([{ id: callId, name: "read_file", args: { path: "src/foo.ts" } }]), mockState, mockCapabilities);
    await director.decide(makeToolDoneEvent(callId), mockState, mockCapabilities);
    expect(director.getState().filesRead!.some((e) => e.path === "src/foo.ts")).toBe(true);
  });

  test("list_dir does not add to filesRead", async () => {
    const director = createCodingDirector("", []);
    const callId = "call-ld";
    await director.decide(makeInferenceDoneEvent([{ id: callId, name: "list_dir", args: { path: "src/" } }]), mockState, mockCapabilities);
    await director.decide(makeToolDoneEvent(callId), mockState, mockCapabilities);
    expect(director.getState().filesRead).toEqual([]);
  });

  test("filesRead is restored on setState (simulates resume)", () => {
    const director = createCodingDirector("", []);
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
    const director = createCodingDirector("", []);
    expect(director.getState().filesRead).toEqual([]);
  });

  test("getFilesReadAtTurn exposes path-to-turn map", async () => {
    const director = createCodingDirector("", []);
    const callId = "call-r2";
    await director.decide(makeInferenceDoneEvent([{ id: callId, name: "read_file", args: { path: "src/bar.ts" } }]), mockState, mockCapabilities);
    await director.decide(makeToolDoneEvent(callId), mockState, mockCapabilities);
    expect(director.getFilesReadAtTurn().has("src/bar.ts")).toBe(true);
  });
});

describe("submit_output without plan", () => {
  async function submitWithoutPlan(turnsUsed: number) {
    const director = createCodingDirector("", []);
    director.setState({ turnsUsed, submitCalled: false, callIdToName: {}, idleCycles: 0, planSubmitted: false, plan: [], filesRead: [] });
    await director.decide(makeInferenceDoneEvent([{ id: "s", name: "submit_output", args: { summary: "done" } }]), mockState, mockCapabilities);
    return director.decide(makeToolDoneEvent("s"), mockState, mockCapabilities);
  }

  function hasWarning(result: ReactorAction | ReactorAction[]): boolean {
    return actionsArray(result).some((a) => a.type === "reply" && "content" in a && String(a.content).startsWith("Warning"));
  }

  test("accepted without warning on a short task", async () => {
    const result = await submitWithoutPlan(2);
    expect(hasWarning(result)).toBe(false);
  });

  test("no warning at exactly 3 turns", async () => {
    const result = await submitWithoutPlan(3);
    expect(hasWarning(result)).toBe(false);
  });

  test("warning when task ran more than 3 turns without a plan", async () => {
    const result = await submitWithoutPlan(4);
    expect(hasWarning(result)).toBe(true);
  });
});

describe("operator declined tool calls", () => {
  const declined = "Blocked by permission policy: Operator declined: Run shell command (npm view hono version)";

  function stopsAfterDecline(result: ReactorAction | ReactorAction[]): boolean {
    const actions = actionsArray(result);
    return (
      actions.some((a) => a.type === "checkpoint" && "message" in a && a.message === "operator-declined") &&
      actions.some((a) => a.type === "reply" && "content" in a && a.content === "Tool call rejected by operator.") &&
      actions.some((a) => a.type === "done") &&
      !actions.some((a) => a.type === "infer")
    );
  }

  test("coding director ends the run instead of re-inferring", async () => {
    const director = createCodingDirector("", []);
    const result = await director.decide(makeToolErrorEvent("c", declined), mockState, mockCapabilities);
    expect(stopsAfterDecline(result)).toBe(true);
  });

  test("chat director ends the run instead of re-inferring", async () => {
    const director = createChatDirector("", [], async () => true);
    const result = await director.decide(makeToolErrorEvent("c", declined), mockState, mockCapabilities);
    expect(stopsAfterDecline(result)).toBe(true);
  });
});

describe("getTurnsUsed", () => {
  test("returns 0 on a fresh director", () => {
    const director = createCodingDirector("", []);
    expect(director.getTurnsUsed()).toBe(0);
  });

  test("increments after each inference.done event", async () => {
    const director = createCodingDirector("", []);
    await director.decide(makeInferenceDoneEvent([]), mockState, mockCapabilities);
    expect(director.getTurnsUsed()).toBe(1);
    await director.decide(makeInferenceDoneEvent([]), mockState, mockCapabilities);
    expect(director.getTurnsUsed()).toBe(2);
  });
});

describe("chatDirector.signalNewTask", () => {
  function makeMessageReceivedEvent(content: string) {
    return {
      type: "message.received",
      message: { role: "user", content },
    } as unknown as ReactorInboundEvent;
  }

  // Capabilities that preserve the systemPrompt from infer() so we can assert on it.
  const capabilitiesWithInferArgs: ReactorCapabilities = {
    ...mockCapabilities,
    infer: (opts) => ({ type: "infer", ...(opts ?? {}) } as unknown as ReactorAction),
  };

  test("summary is included in system prompt when next task boundary is detected", async () => {
    const classifier = async (_msg: string, _meta: unknown) => ({ kind: "new_task" as const, reason: "pivot" });
    const director = createChatDirector("base-prompt", [], async () => true, classifier);

    director.signalNewTask("prior task: fixed the auth bug");

    const result = await director.decide(makeMessageReceivedEvent("Now build a dashboard"), mockState, capabilitiesWithInferArgs);
    const actions = Array.isArray(result) ? result : [result];
    const inferAction = actions.find((a) => a.type === "infer") as Record<string, unknown> | undefined;
    expect(inferAction).toBeDefined();
    expect(String(inferAction!.systemPrompt)).toContain("prior task: fixed the auth bug");
  });

  test("no summary means context-cleared envelope is used", async () => {
    const classifier = async (_msg: string, _meta: unknown) => ({ kind: "new_task" as const, reason: "pivot" });
    const director = createChatDirector("base-prompt", [], async () => true, classifier);

    director.signalNewTask(undefined);

    const result = await director.decide(makeMessageReceivedEvent("Start fresh"), mockState, capabilitiesWithInferArgs);
    const actions = Array.isArray(result) ? result : [result];
    const inferAction = actions.find((a) => a.type === "infer") as Record<string, unknown> | undefined;
    expect(inferAction).toBeDefined();
    expect(String(inferAction!.systemPrompt)).toContain("--- Context cleared for new task ---");
  });
});

describe("consecutive reads are not capped", () => {
  test("consecutiveReads field is absent from persisted state", () => {
    const director = createCodingDirector("", []);
    const state = director.getState();
    expect("consecutiveReads" in state).toBe(false);
  });

  test("director does not abort after 8 consecutive read_file calls", async () => {
    const director = createCodingDirector("", []);

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
