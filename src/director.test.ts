import { describe, test, expect } from "bun:test";
import { createChatDirector } from "./agent/director.js";
import { createAgentToolset } from "./agent/tools.js";
import { createPermissionGate } from "./permission/gate.js";
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

describe("operator declined tool calls", () => {
  const declined = "Blocked by permission policy: Operator declined: Run shell command (npm view hono version)";

  const hasCheckpoint = (actions: ReactorAction[]): boolean =>
    actions.some((a) => a.type === "checkpoint" && "message" in a && a.message === "operator-declined");
  const hasDeclineReply = (actions: ReactorAction[]): boolean =>
    actions.some((a) => a.type === "reply" && "content" in a && a.content === "Tool call rejected by operator.");
  const hasInfer = (actions: ReactorAction[]): boolean => actions.some((a) => a.type === "infer");
  const hasDone = (actions: ReactorAction[]): boolean => actions.some((a) => a.type === "done");

  // CL-1698 contract — interactive chat surfaces the rejection and waits for
  // the next user message; it does NOT emit done(), which would kill the
  // reactor and break further sends, and it does not re-infer off a bare
  // decline.
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

describe("open-task termination guard", () => {
  const declined = "Blocked by permission policy: Operator declined: Run shell command (rm -rf build)";

  const manageTasksEvent = (status: "todo" | "doing" | "done") =>
    makeInferenceDoneEvent([
      { id: "m", name: "manage_tasks", args: { action: "create", tasks: [{ id: "t1", title: "work", status }] } },
    ]);

  const textTurn = (): ReactorInboundEvent =>
    ({
      type: "inference.done",
      turn: { role: "assistant", model: "test", timestamp: 0, content: [{ type: "text", text: "all set" }] },
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { model: "test-model" },
    }) as unknown as ReactorInboundEvent;

  const hasInfer = (a: ReactorAction[]): boolean => a.some((x) => x.type === "infer");
  const hasReply = (a: ReactorAction[]): boolean => a.some((x) => x.type === "reply");

  test("re-infers instead of ending the turn while a task is still open", async () => {
    const director = createChatDirector("base", []);
    await director.decide(manageTasksEvent("doing"), mockState, mockCapabilities);

    const actions = actionsArray(await director.decide(textTurn(), mockState, mockCapabilities));
    expect(hasInfer(actions)).toBe(true);
    expect(hasReply(actions)).toBe(false);
  });

  test("ends the turn normally once every task is terminal", async () => {
    const director = createChatDirector("base", []);
    await director.decide(manageTasksEvent("done"), mockState, mockCapabilities);

    const actions = actionsArray(await director.decide(textTurn(), mockState, mockCapabilities));
    expect(hasReply(actions)).toBe(true);
    expect(hasInfer(actions)).toBe(false);
  });

  test("stops nudging and lets the turn end after the cap of content-free attempts", async () => {
    const director = createChatDirector("base", []);
    await director.decide(manageTasksEvent("doing"), mockState, mockCapabilities);

    for (let i = 0; i < 3; i++) {
      const nudged = actionsArray(await director.decide(textTurn(), mockState, mockCapabilities));
      expect(hasInfer(nudged)).toBe(true);
    }
    const exhausted = actionsArray(await director.decide(textTurn(), mockState, mockCapabilities));
    expect(hasReply(exhausted)).toBe(true);
    expect(hasInfer(exhausted)).toBe(false);
  });

  test("a declined tool with open tasks re-infers, then terminates after its cap", async () => {
    const director = createChatDirector("base", []);
    await director.decide(manageTasksEvent("doing"), mockState, mockCapabilities);

    for (let i = 0; i < 2; i++) {
      const nudged = actionsArray(await director.decide(makeToolErrorEvent("c", declined), mockState, mockCapabilities));
      expect(nudged.some((a) => a.type === "infer")).toBe(true);
      expect(nudged.some((a) => a.type === "reply")).toBe(false);
    }
    const ended = actionsArray(await director.decide(makeToolErrorEvent("c", declined), mockState, mockCapabilities));
    expect(ended.some((a) => a.type === "reply" && "content" in a && a.content === "Tool call rejected by operator.")).toBe(true);
    expect(ended.some((a) => a.type === "infer")).toBe(false);
  });

  test("an interleaved tool call resets the idle budget, so only consecutive attempts count", async () => {
    const director = createChatDirector("base", []);
    await director.decide(manageTasksEvent("doing"), mockState, mockCapabilities);

    // Two content-free terminations spend two of the three nudges.
    expect(hasInfer(actionsArray(await director.decide(textTurn(), mockState, mockCapabilities)))).toBe(true);
    expect(hasInfer(actionsArray(await director.decide(textTurn(), mockState, mockCapabilities)))).toBe(true);

    // A turn that does real tool work is progress and resets the budget.
    await director.decide(
      makeInferenceDoneEvent([{ id: "r", name: "read_file", args: { path: "a.txt" } }]),
      mockState,
      mockCapabilities,
    );

    // The full budget is available again: three more nudges before terminating.
    for (let i = 0; i < 3; i++) {
      expect(hasInfer(actionsArray(await director.decide(textTurn(), mockState, mockCapabilities)))).toBe(true);
    }
    const ended = actionsArray(await director.decide(textTurn(), mockState, mockCapabilities));
    expect(hasReply(ended)).toBe(true);
    expect(hasInfer(ended)).toBe(false);
  });

  test("a declined tool with no open tasks surfaces the decline immediately", async () => {
    const director = createChatDirector("base", []);
    const actions = actionsArray(await director.decide(makeToolErrorEvent("c", declined), mockState, mockCapabilities));
    expect(actions.some((a) => a.type === "reply" && "content" in a && a.content === "Tool call rejected by operator.")).toBe(true);
    expect(actions.some((a) => a.type === "infer")).toBe(false);
  });
});

describe("chatDirector compaction", () => {
  function textInferenceDone(inputTokens: number): ReactorInboundEvent {
    return {
      type: "inference.done",
      turn: {
        role: "assistant",
        model: "test",
        timestamp: 0,
        content: [{ type: "text", text: "done" }],
      },
      usage: { input: inputTokens, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { model: "test-model" },
    } as unknown as ReactorInboundEvent;
  }

  function messageReceived(content: string): ReactorInboundEvent {
    return {
      type: "message.received",
      message: { role: "user", content },
    } as unknown as ReactorInboundEvent;
  }

  test("schedules idle compaction after an over-threshold text-only reply", async () => {
    let continuations = 0;
    const director = createChatDirector("", [], undefined, undefined, undefined, undefined, undefined, undefined, () => {
      continuations++;
    });
    const longState = { turns: Array.from({ length: 7 }, () => ({ role: "user", content: [], timestamp: 0 })) } as unknown as ReactorState;

    const replyActions = actionsArray(await director.decide(textInferenceDone(999_999), longState, mockCapabilities));
    expect(replyActions.some((a) => a.type === "reply")).toBe(true);
    expect(replyActions.some((a) => a.type === "compact")).toBe(false);
    expect(continuations).toBe(1);

    const compactActions = actionsArray(await director.decide(messageReceived(""), longState, mockCapabilities));
    expect(compactActions).toEqual([
      { type: "compact", compactor: "pruning-compactor", reason: "context-threshold" },
    ]);
  });

  const longState = { turns: Array.from({ length: 7 }, () => ({ role: "user", content: [], timestamp: 0 })) } as unknown as ReactorState;

  function overThresholdToolTurn(): ReactorInboundEvent {
    return {
      type: "inference.done",
      turn: {
        role: "assistant",
        model: "test",
        timestamp: 0,
        content: [{ type: "tool_call", id: "t1", name: "read_file", arguments: { path: "a.txt" } }],
      },
      usage: { input: 999_999, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { model: "test-model" },
    } as unknown as ReactorInboundEvent;
  }

  function overflowError(): ReactorInboundEvent {
    return {
      type: "inference.error",
      error: { category: "context_overflow", message: "context window exceeded" },
    } as unknown as ReactorInboundEvent;
  }

  function chatDirectorWithContinuation(onContinuation?: () => void) {
    return createChatDirector("", [], undefined, undefined, undefined, undefined, undefined, undefined, onContinuation ?? (() => {}));
  }

  test("compacts at the tool.done pause once over threshold", async () => {
    const director = chatDirectorWithContinuation();
    await director.decide(overThresholdToolTurn(), longState, mockCapabilities);
    const actions = actionsArray(await director.decide(makeToolDoneEvent("t1"), longState, mockCapabilities));
    expect(actions.some((a) => a.type === "compact" && "reason" in a && a.reason === "context-threshold")).toBe(true);
    expect(actions.some((a) => a.type === "infer")).toBe(false);

    // The continuation message re-enters inference after the compact cycle.
    const resumed = actionsArray(await director.decide(messageReceived(""), longState, mockCapabilities));
    expect(resumed.some((a) => a.type === "infer")).toBe(true);
  });

  test("a context_overflow inference error triggers compact-and-retry, not a terminal reply", async () => {
    let continuations = 0;
    const director = chatDirectorWithContinuation(() => continuations++);
    const actions = actionsArray(await director.decide(overflowError(), longState, mockCapabilities));
    expect(actions).toEqual([
      { type: "compact", compactor: "pruning-compactor", reason: "context-overflow" },
    ]);
    expect(continuations).toBe(1);

    const resumed = actionsArray(await director.decide(messageReceived(""), longState, mockCapabilities));
    expect(resumed.some((a) => a.type === "infer")).toBe(true);
  });

  test("overflow recovery is bounded so an incompressible history cannot loop forever", async () => {
    const director = chatDirectorWithContinuation();
    for (let i = 0; i < 2; i++) {
      const actions = actionsArray(await director.decide(overflowError(), longState, mockCapabilities));
      expect(actions.some((a) => a.type === "compact")).toBe(true);
      await director.decide(messageReceived(""), longState, mockCapabilities);
    }
    const exhausted = actionsArray(await director.decide(overflowError(), longState, mockCapabilities));
    expect(exhausted.some((a) => a.type === "compact")).toBe(false);
  });

  test("chat posture is preserved: an idle turn never terminates the session", async () => {
    const director = chatDirectorWithContinuation();
    const idle = actionsArray(await director.decide(textInferenceDone(10), longState, mockCapabilities));
    expect(idle.some((a) => a.type === "done")).toBe(false);

    const overThreshold = actionsArray(await director.decide(textInferenceDone(999_999), longState, mockCapabilities));
    expect(overThreshold.some((a) => a.type === "done")).toBe(false);
    const afterCompact = actionsArray(await director.decide(messageReceived(""), longState, mockCapabilities));
    expect(afterCompact.some((a) => a.type === "done")).toBe(false);
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
  const inferToolNames = (action: Record<string, unknown> | undefined): string[] => {
    const tools = (action?.options as Record<string, unknown> | undefined)?.tools;
    return Array.isArray(tools) ? tools.map((t) => (t as { name: string }).name) : [];
  };

  const inferTools = (action: Record<string, unknown> | undefined): unknown =>
    (action?.options as Record<string, unknown> | undefined)?.tools;
  const firstInferTools = async (
    director: ReturnType<typeof createChatDirector>,
    event: ReactorInboundEvent,
  ): Promise<unknown> => {
    const result = await director.decide(event, mockState, capabilitiesWithInferArgs);
    const actions = Array.isArray(result) ? result : [result];
    return inferTools(actions.find((a) => a.type === "infer") as Record<string, unknown> | undefined);
  };

  test("a tool registered after construction is advertised on the next inference", async () => {
    const director = createChatDirector("base-prompt", []);
    director.updateToolDefinitions([lateTool]);

    const result = await director.decide(makeMessageReceivedEvent("hello"), mockState, capabilitiesWithInferArgs);
    const actions = Array.isArray(result) ? result : [result];
    const inferAction = actions.find((a) => a.type === "infer") as Record<string, unknown> | undefined;
    expect(inferAction).toBeDefined();
    expect(inferToolNames(inferAction)).toContain("mcp__acme__list_issues");
  });

  // The provider cache is a prefix cache keyed on the tools array; a tool_search
  // between turns must not reshape it.
  test("wire tools are byte-identical across a turn that ran tool_search", async () => {
    const director = createChatDirector("base-prompt", [lateTool]);

    const before = await firstInferTools(director, makeMessageReceivedEvent("do work"));

    // A full tool_search round-trip: the model calls it, it resolves. Under the
    // stable-superset design this promotes nothing, so the advertised set is
    // untouched.
    await director.decide(
      makeInferenceDoneEvent([{ id: "ts", name: "tool_search", args: { query: "find files" } }]),
      mockState,
      capabilitiesWithInferArgs,
    );
    await director.decide(makeToolDoneEvent("ts"), mockState, capabilitiesWithInferArgs);

    const after = await firstInferTools(director, makeMessageReceivedEvent("continue"));
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  // advance_workflow is always on the wire so a workflow going active never grows
  // the array and busts the provider cache prefix.
  test("advance_workflow is advertised even with no active workflow", async () => {
    const director = createChatDirector("base-prompt", []);
    director.updateToolDefinitions([lateTool]);

    const result = await director.decide(makeMessageReceivedEvent("hello"), mockState, capabilitiesWithInferArgs);
    const actions = Array.isArray(result) ? result : [result];
    const inferAction = actions.find((a) => a.type === "infer") as Record<string, unknown> | undefined;
    expect(inferToolNames(inferAction)).toContain("advance_workflow");
  });

  test("the new-task path also carries the current tools", async () => {
    const classifier = async (_msg: string, _meta: SessionMetadata) => ({ kind: "new_task" as const, reason: "pivot" } as TaskBoundary);
    const director = createChatDirector("base-prompt", [], classifier);
    director.updateToolDefinitions([lateTool]);

    const result = await director.decide(makeMessageReceivedEvent("new thing"), mockState, capabilitiesWithInferArgs);
    const actions = Array.isArray(result) ? result : [result];
    const inferAction = actions.find((a) => a.type === "infer") as Record<string, unknown> | undefined;
    expect(inferAction).toBeDefined();
    expect(inferToolNames(inferAction)).toContain("mcp__acme__list_issues");
  });
});

describe("advance_workflow handler", () => {
  const buildToolset = (isWorkflowActive: () => boolean) =>
    createAgentToolset({
      cwd: process.cwd(),
      permissionGate: createPermissionGate({ approvals: [], interactive: false, skipPermissions: true }),
      onOperatorGate: async () => ({ kind: "cancel" }),
      isWorkflowActive,
    });

  const runAdvance = async (toolset: Awaited<ReturnType<typeof createAgentToolset>>) => {
    const result = await toolset.dynamicRunner.run(
      { id: "aw", name: "advance_workflow", arguments: {} },
      new AbortController().signal,
    );
    await toolset.dispose();
    return String(result.content);
  };

  test("reports an honest no-op when no workflow is active", async () => {
    const content = await runAdvance(await buildToolset(() => false));
    expect(content).toContain("No active workflow");
    expect(content).not.toContain("Advancing");
  });

  test("acknowledges advancement when a workflow is active", async () => {
    const content = await runAdvance(await buildToolset(() => true));
    expect(content).toContain("Advancing to the next step");
  });
});
