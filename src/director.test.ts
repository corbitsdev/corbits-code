import { describe, test, expect } from "bun:test";
import { createChatDirector, createCodingDirector } from "./agent/director.js";
import type { SessionMetadata, TaskBoundary } from "./session/compactor.js";
import type { ReactorState, ReactorCapabilities, ReactorAction, ReactorInboundEvent } from "@intx/types/runtime";

const mockState: ReactorState = {} as unknown as ReactorState;

const mockCapabilities: ReactorCapabilities = {
  infer: (options) => ({ type: "infer", ...(options !== undefined ? { options } : {}) } as ReactorAction),
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
      tasks: [],
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
    director.setState({ turnsUsed, submitCalled: false, callIdToName: {}, idleCycles: 0, tasks: [], filesRead: [] });
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

});

describe("submit_output with managed tasks", () => {
  const inferPrompt = (result: ReactorAction | ReactorAction[]): string | undefined => {
    const infer = actionsArray(result).find((a) => a.type === "infer") as { options?: { systemPrompt?: string } } | undefined;
    return infer?.options?.systemPrompt;
  };

  test("re-infers instead of completing when tasks are unfinished", async () => {
    const director = createCodingDirector("base prompt", []);
    await director.decide(
      makeInferenceDoneEvent([
        {
          id: "tasks",
          name: "manage_tasks",
          args: { action: "create", tasks: [{ id: "t1", title: "Finish work", status: "doing" }] },
        },
        { id: "submit", name: "submit_output", args: { summary: "done" } },
      ]),
      mockState,
      mockCapabilities,
    );

    const result = await director.decide(makeToolDoneEvent("submit"), mockState, mockCapabilities);

    expect(actionsArray(result).some((a) => a.type === "done")).toBe(false);
    expect(inferPrompt(result)).toContain("manage_tasks list still has unfinished items");
    expect(inferPrompt(result)).toContain("t1: Finish work (doing)");
    expect(director.getState().submitCalled).toBe(false);
  });

  test("accepts submit_output when managed tasks are done", async () => {
    const director = createCodingDirector("base prompt", []);
    await director.decide(
      makeInferenceDoneEvent([
        {
          id: "tasks",
          name: "manage_tasks",
          args: { action: "create", tasks: [{ id: "t1", title: "Finish work", status: "done" }] },
        },
        { id: "submit", name: "submit_output", args: { summary: "done" } },
      ]),
      mockState,
      mockCapabilities,
    );

    await director.decide(makeToolDoneEvent("submit"), mockState, mockCapabilities);
    const result = await director.decide(makeInferenceDoneEvent([]), mockState, mockCapabilities);

    expect(actionsArray(result).some((a) => a.type === "done")).toBe(true);
    expect(director.getState().submitCalled).toBe(true);
  });
});

describe("operator declined tool calls", () => {
  const declined = "Blocked by permission policy: Operator declined: Run shell command (npm view hono version)";

  const hasCheckpoint = (actions: ReactorAction[]): boolean =>
    actions.some((a) => a.type === "checkpoint" && "message" in a && a.message === "operator-declined");
  const hasDeclineReply = (actions: ReactorAction[]): boolean =>
    actions.some((a) => a.type === "reply" && "content" in a && a.content === "Tool call rejected by operator.");
  const hasInfer = (actions: ReactorAction[]): boolean => actions.some((a) => a.type === "infer");
  const hasDone = (actions: ReactorAction[]): boolean => actions.some((a) => a.type === "done");

  // CL-1698 contract — the two surfaces differ deliberately:
  //  - Headless (coding): end the run cleanly with a reply explaining why + done.
  //  - Interactive (chat): surface the rejection and wait for the next user
  //    message; do NOT emit done(), which would kill the reactor and break
  //    further sends. Neither surface re-infers off a bare decline.
  test("coding director ends the run with a reply and done, without re-inferring", async () => {
    const director = createCodingDirector("", []);
    const actions = actionsArray(await director.decide(makeToolErrorEvent("c", declined), mockState, mockCapabilities));
    expect(hasCheckpoint(actions)).toBe(true);
    expect(hasDeclineReply(actions)).toBe(true);
    expect(hasDone(actions)).toBe(true);
    expect(hasInfer(actions)).toBe(false);
  });

  test("chat director surfaces the decline and waits, keeping the reactor alive", async () => {
    const director = createChatDirector("", []);
    const actions = actionsArray(await director.decide(makeToolErrorEvent("c", declined), mockState, mockCapabilities));
    expect(hasCheckpoint(actions)).toBe(true);
    expect(hasDeclineReply(actions)).toBe(true);
    // No done(): the TUI must stay alive so the user can send another message.
    expect(hasDone(actions)).toBe(false);
    expect(hasInfer(actions)).toBe(false);
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

  // Capabilities that preserve the infer options so we can assert on them. Mirrors
  // the real ReactorAction infer shape, which nests options under `options`.
  const capabilitiesWithInferArgs: ReactorCapabilities = {
    ...mockCapabilities,
    infer: (opts) => ({ type: "infer", options: opts } as unknown as ReactorAction),
  };

  const inferSystemPrompt = (action: Record<string, unknown> | undefined): string =>
    String((action?.options as Record<string, unknown> | undefined)?.systemPrompt);

  test("summary is included in system prompt when next task boundary is detected", async () => {
    const classifier = async (_msg: string, _meta: SessionMetadata) => ({ kind: "new_task" as const, reason: "pivot" } as TaskBoundary);
    const director = createChatDirector("base-prompt", [], classifier);

    director.signalNewTask("prior task: fixed the auth bug");

    const result = await director.decide(makeMessageReceivedEvent("Now build a dashboard"), mockState, capabilitiesWithInferArgs);
    const actions = Array.isArray(result) ? result : [result];
    const inferAction = actions.find((a) => a.type === "infer") as Record<string, unknown> | undefined;
    expect(inferAction).toBeDefined();
    expect(inferSystemPrompt(inferAction)).toContain("prior task: fixed the auth bug");
  });

  test("no summary means context-cleared envelope is used", async () => {
    const classifier = async (_msg: string, _meta: SessionMetadata) => ({ kind: "new_task" as const, reason: "pivot" } as TaskBoundary);
    const director = createChatDirector("base-prompt", [], classifier);

    director.signalNewTask(undefined);

    const result = await director.decide(makeMessageReceivedEvent("Start fresh"), mockState, capabilitiesWithInferArgs);
    const actions = Array.isArray(result) ? result : [result];
    const inferAction = actions.find((a) => a.type === "infer") as Record<string, unknown> | undefined;
    expect(inferAction).toBeDefined();
    expect(inferSystemPrompt(inferAction)).toContain("--- Context cleared for new task ---");
  });
});

describe("chatDirector LSP auto-activation", () => {
  test("reading a code file activates the lsp tool on success", async () => {
    const activated: string[][] = [];
    const director = createChatDirector("", [], undefined, (names: string[]) => activated.push(names));
    await director.decide(makeInferenceDoneEvent([{ id: "c", name: "read_file", args: { path: "src/foo.ts" } }]), mockState, mockCapabilities);
    await director.decide(makeToolDoneEvent("c"), mockState, mockCapabilities);
    expect(activated).toEqual([["lsp"]]);
  });

  test("editing a code file activates lsp", async () => {
    const activated: string[][] = [];
    const director = createChatDirector("", [], undefined, (names: string[]) => activated.push(names));
    await director.decide(makeInferenceDoneEvent([{ id: "c", name: "edit_file", args: { path: "lib/bar.rs" } }]), mockState, mockCapabilities);
    await director.decide(makeToolDoneEvent("c"), mockState, mockCapabilities);
    expect(activated).toEqual([["lsp"]]);
  });

  test("a non-code file does not activate lsp", async () => {
    const activated: string[][] = [];
    const director = createChatDirector("", [], undefined, (names: string[]) => activated.push(names));
    await director.decide(makeInferenceDoneEvent([{ id: "c", name: "read_file", args: { path: "README.md" } }]), mockState, mockCapabilities);
    await director.decide(makeToolDoneEvent("c"), mockState, mockCapabilities);
    expect(activated).toEqual([]);
  });

  test("a failed read does not activate lsp", async () => {
    const activated: string[][] = [];
    const director = createChatDirector("", [], undefined, (names: string[]) => activated.push(names));
    await director.decide(makeInferenceDoneEvent([{ id: "c", name: "read_file", args: { path: "src/foo.ts" } }]), mockState, mockCapabilities);
    await director.decide(makeToolErrorEvent("c", "Error: not found"), mockState, mockCapabilities);
    expect(activated).toEqual([]);
  });
});

describe("updateToolDefinitions rewrites infer tools", () => {
  const makeMessageReceivedEvent = (content: string) =>
    ({ type: "message.received", message: { role: "user", content } }) as unknown as ReactorInboundEvent;
  const capabilitiesWithInferArgs: ReactorCapabilities = {
    ...mockCapabilities,
    infer: (opts) => ({ type: "infer", options: opts } as unknown as ReactorAction),
  };
  const lateTool = { name: "mcp__acme__list_issues", description: "list", inputSchema: { type: "object" } };
  const inferTools = (action: Record<string, unknown> | undefined): unknown =>
    (action?.options as Record<string, unknown> | undefined)?.tools;

  test("a tool registered after construction is advertised on the next inference", async () => {
    const director = createChatDirector("base-prompt", []);
    director.updateToolDefinitions([lateTool]);

    const result = await director.decide(makeMessageReceivedEvent("hello"), mockState, capabilitiesWithInferArgs);
    const actions = Array.isArray(result) ? result : [result];
    const inferAction = actions.find((a) => a.type === "infer") as Record<string, unknown> | undefined;
    expect(inferAction).toBeDefined();
    expect(inferTools(inferAction)).toEqual([lateTool]);
  });

  test("the new-task path also carries the current tools", async () => {
    const classifier = async (_msg: string, _meta: SessionMetadata) => ({ kind: "new_task" as const, reason: "pivot" } as TaskBoundary);
    const director = createChatDirector("base-prompt", [], classifier);
    director.updateToolDefinitions([lateTool]);

    const result = await director.decide(makeMessageReceivedEvent("new thing"), mockState, capabilitiesWithInferArgs);
    const actions = Array.isArray(result) ? result : [result];
    const inferAction = actions.find((a) => a.type === "infer") as Record<string, unknown> | undefined;
    expect(inferAction).toBeDefined();
    expect(inferTools(inferAction)).toEqual([lateTool]);
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
