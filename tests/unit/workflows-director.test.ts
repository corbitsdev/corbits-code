import { test, expect } from "bun:test";
import type {
  ReactorInboundEvent,
  ReactorState,
  ReactorCapabilities,
  ReactorAction,
  TokenUsage,
  ToolResult,
} from "@intx/types/runtime";
import { createChatDirector } from "../../src/agent/director.js";
import { WorkflowRuntime } from "../../src/workflows/runtime.js";
import { WorkflowCoordinator } from "../../src/workflows/coordinator.js";
import type { CapabilityMap } from "../../src/workflows/capabilities.js";
import type { Workflow } from "../../src/workflows/types.js";

const usage: TokenUsage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 };

const state: ReactorState = {
  turns: [],
  activeForks: [],
  pendingOperations: [],
  activeGates: [],
  tokenUsage: usage,
  lastCycleUsage: null,
  lastCycleSource: null,
  sessionId: "test-session",
};

function makeCapabilities(): ReactorCapabilities {
  return {
    infer: (options) => (options === undefined ? { type: "infer" } : { type: "infer", options }),
    executeTools: () => ({ type: "execute_tools", calls: [] }),
    suspend: (gate) => ({ type: "suspend", gate }),
    fork: (mode, forkId) => ({ type: "fork", mode, forkId }),
    emit: (eventType, data) => ({ type: "emit", eventType, data }),
    reply: (content) => ({ type: "reply", content }),
    checkpoint: (message = "") => ({ type: "checkpoint", message }),
    compact: (compactor, reason) => ({ type: "compact", compactor, reason }),
    wait: () => ({ type: "wait" }),
    done: () => ({ type: "done" }),
  };
}

const flow: Workflow = {
  name: "flow",
  description: "two steps",
  steps: [
    { id: "a", label: "Step A", prompt: "do a" },
    { id: "b", label: "Step B", prompt: "do b" },
  ],
};

const emptyCaps: CapabilityMap = new Map();

function inferActions(result: ReactorAction | ReactorAction[]): {
  type: "infer";
  options?: {
    systemPrompt?: string;
    tools?: { name: string }[];
    ephemeralTurns?: { role: string; content: unknown }[];
  };
}[] {
  const arr = Array.isArray(result) ? result : [result];
  return arr.filter((a) => a.type === "infer") as {
    type: "infer";
    options?: {
      systemPrompt?: string;
      tools?: { name: string }[];
      ephemeralTurns?: { role: string; content: unknown }[];
    };
  }[];
}

function ephemeralNudgeText(result: ReactorAction | ReactorAction[]): string {
  const infers = inferActions(result);
  const turns = infers[0]?.options?.ephemeralTurns ?? [];
  return turns
    .flatMap((t) => {
      const content = t.content;
      if (!Array.isArray(content)) return [];
      return content
        .filter(
          (p): p is { type: "text"; text: string } =>
            typeof p === "object" && p !== null && (p as { type?: string }).type === "text",
        )
        .map((p) => p.text);
    })
    .join("\n");
}

test("the active step directive is injected into the inferred system prompt", async () => {
  const runtime = new WorkflowRuntime(emptyCaps, (n) => (n === "flow" ? flow : undefined));
  runtime.start(flow);
  const coordinator = new WorkflowCoordinator(runtime);
  const director = createChatDirector("BASE PROMPT", [], {
    onTasksChange: () => {},
    workflowCoordinator: coordinator,
  });

  const event: ReactorInboundEvent = {
    type: "message.received",
    message: {
      ref: { uid: 1, mailbox: "INBOX" },
      headers: {
        from: "user@test",
        to: ["agent@test"],
        date: "1970-01-01T00:00:00Z",
        messageId: "m1",
      },
      flags: [],
      signatureStatus: "missing",
      content: "go",
    },
  };
  const result = await director.decide(event, state, makeCapabilities());

  const infers = inferActions(result);
  expect(infers.length).toBeGreaterThan(0);
  const prompt = infers[0]?.options?.systemPrompt ?? "";
  expect(prompt).toContain("BASE PROMPT");
  expect(ephemeralNudgeText(result)).toContain("[WORKFLOW STEP 1/2: Step A]");
  const toolNames = (infers[0]?.options?.tools ?? []).map((t) => t.name);
  expect(toolNames).toContain("submit_output");
  expect(toolNames).not.toContain("advance_workflow");
});

test("a submit_output tool call with the current step id advances the runtime through the director", async () => {
  const runtime = new WorkflowRuntime(emptyCaps, (n) => (n === "flow" ? flow : undefined));
  runtime.start(flow);
  const coordinator = new WorkflowCoordinator(runtime);
  const director = createChatDirector("BASE", [], {
    onTasksChange: () => {},
    workflowCoordinator: coordinator,
  });
  const caps = makeCapabilities();

  const turn: ReactorInboundEvent = {
    type: "inference.done",
    turn: {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "call-1",
          name: "submit_output",
          arguments: { step: "a" },
        },
      ],
      model: "test-model",
      timestamp: 0,
    },
    usage,
    source: { sourceId: "t", provider: "openai", model: "test-model" },
  };
  await director.decide(turn, state, caps);

  const result: ToolResult = { callId: "call-1", content: "Advancing.", isError: false };
  await director.decide({ type: "tool.done", result }, state, caps);

  expect(runtime.currentStep()?.id).toBe("b");
});

test("a stale submit_output does not skip ahead through the director", async () => {
  const runtime = new WorkflowRuntime(emptyCaps, (n) => (n === "flow" ? flow : undefined));
  runtime.start(flow);
  const coordinator = new WorkflowCoordinator(runtime);
  const director = createChatDirector("BASE", [], {
    onTasksChange: () => {},
    workflowCoordinator: coordinator,
  });
  const caps = makeCapabilities();

  const turn: ReactorInboundEvent = {
    type: "inference.done",
    turn: {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "call-1",
          name: "submit_output",
          arguments: { step: "a" },
        },
      ],
      model: "test-model",
      timestamp: 0,
    },
    usage,
    source: { sourceId: "t", provider: "openai", model: "test-model" },
  };
  await director.decide(turn, state, caps);
  await director.decide(
    { type: "tool.done", result: { callId: "call-1", content: "Advancing.", isError: false } },
    state,
    caps,
  );
  expect(runtime.currentStep()?.id).toBe("b");

  const stale: ReactorInboundEvent = {
    type: "inference.done",
    turn: {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "call-2",
          name: "submit_output",
          arguments: { step: "a" },
        },
      ],
      model: "test-model",
      timestamp: 0,
    },
    usage,
    source: { sourceId: "t", provider: "openai", model: "test-model" },
  };
  await director.decide(stale, state, caps);
  await director.decide(
    {
      type: "tool.done",
      result: { callId: "call-2", content: "already complete", isError: false },
    },
    state,
    caps,
  );
  expect(runtime.currentStep()?.id).toBe("b");
});

function hasInfer(result: ReactorAction | ReactorAction[]): boolean {
  return (Array.isArray(result) ? result : [result]).some((a) => a.type === "infer");
}

function textTurn(text: string): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      content: [{ type: "text", text }],
      model: "test-model",
      timestamp: 0,
    },
    usage,
    source: { sourceId: "t", provider: "openai", model: "test-model" },
  };
}

test("auto-continuation fires on reply() as well as wait() after a text turn", async () => {
  const runtime = new WorkflowRuntime(emptyCaps, (n) => (n === "flow" ? flow : undefined));
  runtime.start(flow);
  const coordinator = new WorkflowCoordinator(runtime);
  const director = createChatDirector("BASE", [], {
    onTasksChange: () => {},
    workflowCoordinator: coordinator,
  });
  const caps = makeCapabilities();

  // Simulate a text-only inference turn (no tool calls).
  await director.decide(textTurn("I reviewed the diff, moving to next step."), state, caps);

  // The DefaultDirector in conversational mode returns [checkpoint, reply(text)] for a text turn.
  // The auto-continuation must recognise reply() as a terminal action and replace it with infer().
  // We bypass DefaultDirector by injecting the reply action directly via the base class path.
  // Instead, verify: after a text turn, the director's next inference.done with reply-like base
  // output produces an infer action (auto-continuation triggered).
  //
  // Use a second text turn to confirm idleTurns=1 still produces infer, not wait.
  const result = await director.decide(textTurn("continuing review..."), state, caps);
  // The director would have received [checkpoint, reply] from DefaultDirector but auto-continuation
  // should have replaced it with infer. Since we can't intercept DefaultDirector output here,
  // verify the stable invariant: after 2 consecutive text turns the director still auto-continues
  // (workflowIdleTurns < 3).
  expect(hasInfer(result)).toBe(true);
});

function manageTasksTurn(status: "todo" | "doing" | "done"): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "mt",
          name: "manage_tasks",
          arguments: { action: "create", tasks: [{ id: "t1", title: "work", status }] },
        },
      ],
      model: "test-model",
      timestamp: 0,
    },
    usage,
    source: { sourceId: "t", provider: "openai", model: "test-model" },
  };
}

function emptyTurn(): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: { role: "assistant", content: [], model: "test-model", timestamp: 0 },
    usage,
    source: { sourceId: "t", provider: "openai", model: "test-model" },
  };
}

// A content-free terminal turn inside an active workflow is nudged by the
// general open-task guard, which must point at submit_output rather than the
// non-workflow manage_tasks guidance.
test("a content-free workflow turn with open tasks nudges toward submit_output", async () => {
  const runtime = new WorkflowRuntime(emptyCaps, (n) => (n === "flow" ? flow : undefined));
  runtime.start(flow);
  const coordinator = new WorkflowCoordinator(runtime);
  const director = createChatDirector("BASE", [], {
    onTasksChange: () => {},
    workflowCoordinator: coordinator,
  });
  const caps = makeCapabilities();

  await director.decide(manageTasksTurn("doing"), state, caps);
  const result = await director.decide(emptyTurn(), state, caps);

  // The active step directive always appends its own "call submit_output"
  // line, so assert against text unique to the workflow nudge and the absence
  // of the general nudge's phrasing — otherwise the test passes either way.
  const infers = inferActions(result);
  expect(infers.length).toBeGreaterThan(0);
  const nudge = ephemeralNudgeText(result);
  expect(nudge).toContain("a workflow step is active");
  expect(nudge).not.toContain("mark each task done or cancelled with manage_tasks before ending");
});

// With a workflow active, the workflow stuck-cutoff owns termination. Open tasks
// must not let the general open-task guard override that cutoff into an endless
// nudge — the workflow path still hands back after 3 idle turns.
test("open tasks do not defeat the workflow stuck-cutoff after 3 idle turns", async () => {
  const runtime = new WorkflowRuntime(emptyCaps, (n) => (n === "flow" ? flow : undefined));
  runtime.start(flow);
  const coordinator = new WorkflowCoordinator(runtime);
  const director = createChatDirector("BASE", [], {
    onTasksChange: () => {},
    workflowCoordinator: coordinator,
  });
  const caps = makeCapabilities();

  await director.decide(manageTasksTurn("doing"), state, caps);
  await director.decide(textTurn("text 1"), state, caps);
  await director.decide(textTurn("text 2"), state, caps);
  await director.decide(textTurn("text 3"), state, caps);
  const result = await director.decide(textTurn("text 4"), state, caps);

  expect(hasInfer(result)).toBe(false);
  const actions = Array.isArray(result) ? result : [result];
  expect(actions.some((a) => a.type === "wait" || a.type === "reply")).toBe(true);
});

test("auto-continuation falls back after 3 consecutive text-only turns", async () => {
  const runtime = new WorkflowRuntime(emptyCaps, (n) => (n === "flow" ? flow : undefined));
  runtime.start(flow);
  const coordinator = new WorkflowCoordinator(runtime);
  const director = createChatDirector("BASE", [], {
    onTasksChange: () => {},
    workflowCoordinator: coordinator,
  });
  const caps = makeCapabilities();

  await director.decide(textTurn("text 1"), state, caps);
  await director.decide(textTurn("text 2"), state, caps);
  await director.decide(textTurn("text 3"), state, caps);
  const result = await director.decide(textTurn("text 4"), state, caps);
  // After 3+ idle (text-only) turns the director must stop re-inferring and hand
  // back to the user. In chat mode this is a reply(); headless uses wait().
  const actions = Array.isArray(result) ? result : [result];
  expect(hasInfer(result)).toBe(false);
  expect(actions.some((a) => a.type === "wait" || a.type === "reply")).toBe(true);
});
