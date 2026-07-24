import { describe, test, expect } from "bun:test";
import { createChatDirector } from "./agent/director.js";
import { createAgentToolset } from "./agent/tools.js";
import { advertisedTools, createActivatedToolTracker } from "./agent/tool-search.js";
import { createPermissionGate } from "./permission/gate.js";
import type { SessionMetadata, TaskBoundary } from "./session/compactor.js";
import type { ReactorState, ReactorCapabilities, ReactorAction, ReactorInboundEvent } from "@intx/types/runtime";
import {
  INFERENCE_ABORT_INTERNAL_RECOVERY,
  INFERENCE_ABORT_USER_STOP,
} from "./inference-abort.js";

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

  // Contract: interactive chat surfaces the rejection and waits for
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

  test("empty model turn settles with an empty reply before wait", async () => {
    // DefaultDirector ends empty responses with bare wait; without a reply,
    // agent.send hangs and the TUI Working spinner sticks forever.
    const director = createChatDirector("base", []);
    const emptyTurn = {
      type: "inference.done",
      turn: { role: "assistant", model: "test", timestamp: 0, content: [] },
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { model: "test-model" },
    } as unknown as ReactorInboundEvent;

    const actions = actionsArray(await director.decide(emptyTurn, mockState, mockCapabilities));
    expect(hasReply(actions)).toBe(true);
    expect(actions.some((a) => a.type === "reply" && "content" in a && a.content === "")).toBe(true);
    expect(actions.some((a) => a.type === "wait")).toBe(true);
    expect(hasInfer(actions)).toBe(false);
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

  // The budget used to reset on any tool call, which taught weak
  // models that no-op shell narration (e.g. `echo`) resets the clock. A model
  // that only echoes between nudges must still converge to the cap within a
  // single user turn — the budget is monotonic per inbound message, not per
  // tool call, so it does not matter whether a tool call happens at all.
  test("a no-op tool call between nudges does not reset the idle budget", async () => {
    const director = createChatDirector("base", []);
    await director.decide(manageTasksEvent("doing"), mockState, mockCapabilities);

    // Two content-free terminations spend two of the three nudges.
    expect(hasInfer(actionsArray(await director.decide(textTurn(), mockState, mockCapabilities)))).toBe(true);
    expect(hasInfer(actionsArray(await director.decide(textTurn(), mockState, mockCapabilities)))).toBe(true);

    // A no-op shell call (echo) is not a new user turn, so it must not buy
    // back budget.
    await director.decide(
      makeInferenceDoneEvent([{ id: "e", name: "run_shell", args: { command: "echo done" } }]),
      mockState,
      mockCapabilities,
    );

    // Only one nudge remains from the original budget of three.
    const nudged = actionsArray(await director.decide(textTurn(), mockState, mockCapabilities));
    expect(hasInfer(nudged)).toBe(true);
    const ended = actionsArray(await director.decide(textTurn(), mockState, mockCapabilities));
    expect(hasReply(ended)).toBe(true);
    expect(hasInfer(ended)).toBe(false);
  });

  test("a new user message resets the idle budget for the next turn", async () => {
    const director = createChatDirector("base", []);
    await director.decide(manageTasksEvent("doing"), mockState, mockCapabilities);

    for (let i = 0; i < 3; i++) {
      expect(hasInfer(actionsArray(await director.decide(textTurn(), mockState, mockCapabilities)))).toBe(true);
    }
    const exhausted = actionsArray(await director.decide(textTurn(), mockState, mockCapabilities));
    expect(hasReply(exhausted)).toBe(true);

    // A fresh inbound user message starts a new turn: the budget is restored.
    await director.decide(
      { type: "message.received", message: { role: "user", content: "keep going" } } as unknown as ReactorInboundEvent,
      mockState,
      mockCapabilities,
    );
    const nudged = actionsArray(await director.decide(textTurn(), mockState, mockCapabilities));
    expect(hasInfer(nudged)).toBe(true);
  });

  test("a successful tool call between declines does not reset the declined budget", async () => {
    const director = createChatDirector("base", []);
    await director.decide(manageTasksEvent("doing"), mockState, mockCapabilities);

    // Spend both of the declined-path nudges, with a successful tool result
    // interleaved after the first. If the successful result reset the budget,
    // a third decline would still re-infer instead of terminating.
    const first = actionsArray(await director.decide(makeToolErrorEvent("c", declined), mockState, mockCapabilities));
    expect(first.some((a) => a.type === "infer")).toBe(true);

    // A successful (non-error) tool result in between must not buy back budget.
    await director.decide(makeToolDoneEvent("ok1"), mockState, mockCapabilities);

    const second = actionsArray(await director.decide(makeToolErrorEvent("c", declined), mockState, mockCapabilities));
    expect(second.some((a) => a.type === "infer")).toBe(true);

    const third = actionsArray(await director.decide(makeToolErrorEvent("c", declined), mockState, mockCapabilities));
    expect(third.some((a) => a.type === "infer")).toBe(false);
    expect(third.some((a) => a.type === "reply" && "content" in a && a.content === "Tool call rejected by operator.")).toBe(true);
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

  test("retries recoverable inference failures within a bounded budget", async () => {
    const director = chatDirectorWithContinuation();
    const timeout = {
      type: "inference.error",
      error: { category: "timeout", message: "request timed out" },
    } as unknown as ReactorInboundEvent;

    for (let i = 0; i < 2; i++) {
      const actions = actionsArray(await director.decide(timeout, longState, mockCapabilities));
      expect(actions.some((action) => action.type === "infer")).toBe(true);
    }

    const exhausted = actionsArray(await director.decide(timeout, longState, mockCapabilities));
    expect(exhausted).toEqual([
      { type: "checkpoint", message: "inference-recovery-exhausted" },
      { type: "reply", content: "The request could not recover. Send a message to resume." },
    ]);
  });

  test("recovers an internally aborted inference but keeps explicit abort terminal", async () => {
    const director = chatDirectorWithContinuation();
    const internalAbort = {
      type: "inference.error",
      error: {
        category: "aborted",
        message: "inference aborted",
        raw: { origin: INFERENCE_ABORT_INTERNAL_RECOVERY },
      },
    } as unknown as ReactorInboundEvent;
    const recovered = actionsArray(await director.decide(internalAbort, longState, mockCapabilities));
    expect(recovered.some((action) => action.type === "infer")).toBe(true);

    const explicitAbort = {
      type: "abort",
      reason: { kind: "operator", message: "cancelled" },
    } as unknown as ReactorInboundEvent;
    const stopped = actionsArray(await director.decide(explicitAbort, longState, mockCapabilities));
    expect(stopped.some((action) => action.type === "done")).toBe(true);
    expect(stopped.some((action) => action.type === "infer")).toBe(false);
  });

  test("does not auto-recover user-stop aborted inference errors", async () => {
    const director = chatDirectorWithContinuation();
    const userStopAbort = {
      type: "inference.error",
      error: {
        category: "aborted",
        message: "inference aborted",
        raw: { origin: INFERENCE_ABORT_USER_STOP },
      },
    } as unknown as ReactorInboundEvent;

    const actions = actionsArray(await director.decide(userStopAbort, longState, mockCapabilities));
    expect(actions.some((action) => action.type === "infer")).toBe(false);
    expect(actions.some((action) => action.type === "checkpoint" && action.message === "inference-recovery")).toBe(false);
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

  // End-to-end: tool_search matches an MCP tool, the runner's promote wiring
  // (mirrored here via createActivatedToolTracker + updateToolDefinitions) grows
  // the wire set once with the tool's full definition, and it then holds steady.
  // On a strict provider, a model can only call a tool
  // that was actually declared on the wire, so promotion must land here.
  test("a tool_search match is on the wire on the next turn, then the array holds stable", async () => {
    const linearTool = {
      name: "mcp__linear__list_issues",
      description: "list issues",
      inputSchema: { type: "object", properties: {}, required: [] },
    };
    const toolset = await createAgentToolset({
      cwd: process.cwd(),
      permissionGate: createPermissionGate({ approvals: [], interactive: false, skipPermissions: true }),
      onOperatorGate: async () => ({ kind: "cancel" }),
    });
    toolset.dynamicRunner.addTools([
      { kind: "string", definition: linearTool, handler: async () => "ok" },
    ]);

    const activated = createActivatedToolTracker();
    const computeAdvertised = (all: ReturnType<typeof toolset.dynamicRunner.currentDefinitions>) =>
      advertisedTools(all, activated.list());
    const director = createChatDirector(
      "base-prompt",
      computeAdvertised(toolset.dynamicRunner.currentDefinitions()),
    );

    // Before discovery: the MCP tool is registered (dispatchable) but not wired.
    const before = await firstInferTools(director, makeMessageReceivedEvent("hello"));
    const beforeNames = (before as Array<{ name: string }>).map((t) => t.name);
    expect(beforeNames).not.toContain("mcp__linear__list_issues");
    const beforeJson = JSON.stringify(before);

    // Simulate the runner's promoteTools: tool_search matched this tool, so it
    // is activated and the director's tool set is updated for the next infer.
    activated.activate(["mcp__linear__list_issues"]);
    director.updateToolDefinitions(computeAdvertised(toolset.dynamicRunner.currentDefinitions()));

    const after = await firstInferTools(director, makeMessageReceivedEvent("continue"));
    const afterTools = after as Array<{ name: string }>;
    const afterNames = afterTools.map((t) => t.name);
    expect(afterNames).toContain("mcp__linear__list_issues");
    // advance_workflow rides along separately (see withCurrentTools), appended
    // after computeAdvertised's result every turn — strip it before comparing
    // the fixed built-in prefix, which must survive untouched ahead of the
    // newly appended MCP tool.
    const beforePrefix = beforeNames.filter((n) => n !== "advance_workflow");
    const afterPrefix = afterNames.filter((n) => n !== "advance_workflow" && n !== "mcp__linear__list_issues");
    expect(afterPrefix).toEqual(beforePrefix);
    expect(afterNames.indexOf("mcp__linear__list_issues")).toBe(beforePrefix.length);

    // A further turn with no new discovery stays byte-identical to `after`.
    const stable = await firstInferTools(director, makeMessageReceivedEvent("keep going"));
    expect(JSON.stringify(stable)).toBe(JSON.stringify(after));
    expect(JSON.stringify(after)).not.toBe(beforeJson);

    await toolset.dispose();
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

describe("transient nudges", () => {
  const manageTasksEvent = (status: "todo" | "doing") =>
    makeInferenceDoneEvent([
      { id: "mt", name: "manage_tasks", args: { action: "create", tasks: [{ id: "t1", title: "x", status }] } },
    ]);

  const textTurn = () =>
    ({
      type: "inference.done",
      turn: { role: "assistant", model: "test", timestamp: 0, content: [{ type: "text", text: "done" }] },
      usage: { input: 0, output: 0 },
      source: "test",
    }) as unknown as ReactorInboundEvent;

  test("open-task nudge uses ephemeralTurns, not systemPrompt", async () => {
    const director = createChatDirector("stable-base", []);
    await director.decide(manageTasksEvent("doing"), mockState, mockCapabilities);
    const actions = actionsArray(await director.decide(textTurn(), mockState, mockCapabilities));
    const infer = actions.find((a) => a.type === "infer");
    expect(infer?.type === "infer" ? infer.options?.ephemeralTurns?.length : 0).toBeGreaterThan(0);
    const nudgeText = infer?.type === "infer"
      ? infer.options?.ephemeralTurns?.[0]?.content?.find((b) => b.type === "text")
      : undefined;
    expect(nudgeText?.type === "text" ? nudgeText.text : "").toContain("tasks are still open");
    if (infer?.type === "infer") {
      expect(infer.options?.systemPrompt).toBeUndefined();
    }
  });
});

describe("goal continue-rule", () => {
  const textTurn = (): ReactorInboundEvent =>
    ({
      type: "inference.done",
      turn: {
        role: "assistant",
        model: "test",
        timestamp: 0,
        content: [{ type: "text", text: "done for now" }],
      },
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { model: "test-model" },
    }) as unknown as ReactorInboundEvent;

  const stateWithTurns: ReactorState = {
    turns: [
      {
        role: "user",
        content: [{ type: "text", text: "make tests green" }],
        timestamp: 0,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "still failing" }],
        timestamp: 1,
      },
    ],
  } as unknown as ReactorState;

  test("active not-met goal rewrites a clean yield into re-infer", async () => {
    const { createGoalGovernor } = await import("./agent/goal.js");
    const director = createChatDirector("base", []);
    const g = createGoalGovernor({
      evaluate: async () => ({ met: false, reason: "tests still red" }),
    });
    g.set("all tests pass");
    g.setCriteria([
      { id: "c1", title: "unit tests green", status: "todo" },
      { id: "c2", title: "typecheck clean", status: "todo" },
    ]);
    director.setGoalGovernor(g);

    const actions = actionsArray(await director.decide(textTurn(), stateWithTurns, mockCapabilities));
    expect(actions.some((a) => a.type === "infer")).toBe(true);
    expect(actions.some((a) => a.type === "reply")).toBe(false);
    expect(g.get()?.turnsUsed).toBe(1);
    expect(g.get()?.lastReason).toContain("tests still red");
  });

  test("met goal leaves terminal reply and marks achieved", async () => {
    const { createGoalGovernor } = await import("./agent/goal.js");
    const director = createChatDirector("base", []);
    const g = createGoalGovernor({
      evaluate: async () => ({ met: true, reason: "green" }),
    });
    g.set("all tests pass");
    g.setCriteria([
      { id: "c1", title: "unit tests green", status: "done" },
      { id: "c2", title: "typecheck clean", status: "done" },
    ]);
    director.setGoalGovernor(g);

    const actions = actionsArray(await director.decide(textTurn(), stateWithTurns, mockCapabilities));
    expect(actions.some((a) => a.type === "reply")).toBe(true);
    expect(actions.some((a) => a.type === "infer")).toBe(false);
    expect(g.get()?.status).toBe("achieved");
  });

  test("open-task nudge still wins over goal when tasks are open", async () => {
    const { createGoalGovernor } = await import("./agent/goal.js");
    let evals = 0;
    const director = createChatDirector("base", []);
    const g = createGoalGovernor({
      evaluate: async () => {
        evals++;
        return { met: false, reason: "should not run yet" };
      },
    });
    g.set("x");
    director.setGoalGovernor(g);

    await director.decide(
      makeInferenceDoneEvent([
        {
          id: "m",
          name: "manage_tasks",
          args: { action: "create", tasks: [{ id: "t1", title: "work", status: "doing" }] },
        },
      ]),
      stateWithTurns,
      mockCapabilities,
    );

    const actions = actionsArray(await director.decide(textTurn(), stateWithTurns, mockCapabilities));
    expect(actions.some((a) => a.type === "infer")).toBe(true);
    expect(evals).toBe(0);
  });
});

describe("session turn and token caps", () => {
  const textTurn = (): ReactorInboundEvent =>
    ({
      type: "inference.done",
      turn: { role: "assistant", model: "test", timestamp: 0, content: [{ type: "text", text: "done" }] },
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { model: "test-model" },
    }) as unknown as ReactorInboundEvent;

  const stateWithTokens = (totalInput: number): ReactorState =>
    ({
      tokenUsage: { input: totalInput, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    }) as unknown as ReactorState;

  const isHalt = (a: ReactorAction[]): boolean =>
    a.some((x) => x.type === "wait") && a.some((x) => x.type === "reply") && !a.some((x) => x.type === "done");
  const isAbort = (a: ReactorAction[]): boolean =>
    a.some((x) => x.type === "done") && a.some((x) => x.type === "reply");

  test("interactive session surfaces a continueable warning once the turn cap is reached", async () => {
    const director = createChatDirector(
      "base", [], undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { maxTurns: 1, interactive: true },
    );
    const actions = actionsArray(await director.decide(textTurn(), stateWithTokens(0), mockCapabilities));
    expect(isHalt(actions)).toBe(true);
  });

  test("a warned interactive session keeps going instead of warning on every turn", async () => {
    const director = createChatDirector(
      "base", [], undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { maxTurns: 1, interactive: true },
    );
    const first = actionsArray(await director.decide(textTurn(), stateWithTokens(0), mockCapabilities));
    expect(isHalt(first)).toBe(true);

    const second = actionsArray(await director.decide(textTurn(), stateWithTokens(0), mockCapabilities));
    expect(isHalt(second)).toBe(false);
    expect(isAbort(second)).toBe(false);
  });

  test("headless (non-interactive) run hard-stops when the turn cap is reached", async () => {
    const director = createChatDirector(
      "base", [], undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { maxTurns: 1, interactive: false },
    );
    const actions = actionsArray(await director.decide(textTurn(), stateWithTokens(0), mockCapabilities));
    expect(isAbort(actions)).toBe(true);
  });

  test("token budget hard-stops a headless run the same way as the turn cap", async () => {
    const director = createChatDirector(
      "base", [], undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { maxTokens: 100, interactive: false },
    );
    const actions = actionsArray(await director.decide(textTurn(), stateWithTokens(500), mockCapabilities));
    expect(isAbort(actions)).toBe(true);
  });

  test("default caps do not fire during ordinary short sessions", async () => {
    const director = createChatDirector("base", []);
    for (let i = 0; i < 5; i++) {
      const actions = actionsArray(await director.decide(textTurn(), stateWithTokens(1000), mockCapabilities));
      expect(isAbort(actions)).toBe(false);
      expect(isHalt(actions)).toBe(false);
    }
  });

  const manageTasksEvent = (status: "todo" | "doing" | "done") =>
    makeInferenceDoneEvent([
      { id: "m", name: "manage_tasks", args: { action: "create", tasks: [{ id: "t1", title: "work", status }] } },
    ]);

  test("the turn cap still halts an interactive session when a task is left open on the capping turn", async () => {
    const director = createChatDirector(
      "base", [], undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { maxTurns: 2, interactive: true },
    );
    // Turn 1: leaves a task open, well under the cap.
    await director.decide(manageTasksEvent("doing"), stateWithTokens(0), mockCapabilities);
    // Turn 2: reaches the cap while the task is still open. Without the fix,
    // the open-task nudge rewrites the halt's wait into a fresh infer(),
    // swallowing the cap and continuing the loop.
    const actions = actionsArray(await director.decide(textTurn(), stateWithTokens(0), mockCapabilities));
    expect(isHalt(actions)).toBe(true);
    expect(actions.some((a) => a.type === "infer")).toBe(false);
  });

  test("the turn cap still aborts a headless run when a task is left open on the capping turn", async () => {
    const director = createChatDirector(
      "base", [], undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { maxTurns: 2, interactive: false },
    );
    await director.decide(manageTasksEvent("doing"), stateWithTokens(0), mockCapabilities);
    const actions = actionsArray(await director.decide(textTurn(), stateWithTokens(0), mockCapabilities));
    expect(isAbort(actions)).toBe(true);
    expect(actions.some((a) => a.type === "infer")).toBe(false);
  });

  test("the open-task nudge still fires normally when no cap is breached", async () => {
    const director = createChatDirector(
      "base", [], undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { maxTurns: 100, interactive: true },
    );
    await director.decide(manageTasksEvent("doing"), stateWithTokens(0), mockCapabilities);
    const actions = actionsArray(await director.decide(textTurn(), stateWithTokens(0), mockCapabilities));
    expect(actions.some((a) => a.type === "infer")).toBe(true);
    expect(isHalt(actions)).toBe(false);
    expect(isAbort(actions)).toBe(false);
  });
});

