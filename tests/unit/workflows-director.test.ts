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
    infer: (options) => ({ type: "infer", options }),
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

function inferActions(result: ReactorAction | ReactorAction[]): Array<{ type: "infer"; options?: { systemPrompt?: string; tools?: { name: string }[] } }> {
  const arr = Array.isArray(result) ? result : [result];
  return arr.filter((a): a is { type: "infer"; options?: { systemPrompt?: string; tools?: { name: string }[] } } => a.type === "infer");
}

test("the active step directive is injected into the inferred system prompt", async () => {
  const runtime = new WorkflowRuntime(emptyCaps, (n) => (n === "flow" ? flow : undefined));
  runtime.start(flow);
  const coordinator = new WorkflowCoordinator(runtime);
  const director = createChatDirector("BASE PROMPT", [], undefined, undefined, undefined, coordinator);

  const event: ReactorInboundEvent = { type: "message.received", message: { role: "user", content: "go" } };
  const result = await director.decide(event, state, makeCapabilities());

  const infers = inferActions(result);
  expect(infers.length).toBeGreaterThan(0);
  const prompt = infers[0]?.options?.systemPrompt ?? "";
  expect(prompt).toContain("BASE PROMPT");
  expect(prompt).toContain("[WORKFLOW STEP 1/2: Step A]");
  const toolNames = (infers[0]?.options?.tools ?? []).map((t) => t.name);
  expect(toolNames).toContain("advance_workflow");
});

test("an advance_workflow tool call advances the runtime through the director", async () => {
  const runtime = new WorkflowRuntime(emptyCaps, (n) => (n === "flow" ? flow : undefined));
  runtime.start(flow);
  const coordinator = new WorkflowCoordinator(runtime);
  const director = createChatDirector("BASE", [], undefined, undefined, undefined, coordinator);
  const caps = makeCapabilities();

  const turn: ReactorInboundEvent = {
    type: "inference.done",
    turn: {
      role: "assistant",
      content: [{ type: "tool_call", id: "call-1", name: "advance_workflow", arguments: {} }],
      model: "test-model",
      timestamp: 0,
    },
    usage,
    source: { id: "t", provider: "openai", model: "test-model" },
  };
  await director.decide(turn, state, caps);

  const result: ToolResult = { callId: "call-1", content: "Advancing.", isError: false };
  await director.decide({ type: "tool.done", result }, state, caps);

  expect(runtime.currentStep()?.id).toBe("b");
});
