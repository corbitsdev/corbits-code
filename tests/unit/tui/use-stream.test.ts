import { test, expect } from "bun:test";
import { createAgentStreamState } from "../../../src/tui/use-stream.js";
import type { ReactorEmittedEvent } from "@intx/inference";

test("createAgentStreamState initial state is empty", () => {
  const state = createAgentStreamState();
  expect(state.contentBlocks.length).toBe(0);
  expect(state.turnsUsed).toBe(0);
  expect(state.status).toBe("running");
  expect(state.totalCost).toBe(0);
  expect(state.totalTokens).toBe(0);
  expect(state.hooks).toEqual([]);
});

test("createAgentStreamState accumulates tool_call events", () => {
  const state = createAgentStreamState();

  const event: ReactorEmittedEvent = {
    type: "inference.tool_call.start",
    seq: 1,
    data: { name: "read_file", callId: "c1" } as unknown as ReactorEmittedEvent["data"],
  };

  state.addEvent(event);
  expect(state.contentBlocks.length).toBe(1);
  expect(state.contentBlocks[0].type).toBe("tool_call");
  expect(state.contentBlocks[0].name).toBe("read_file");
});

test("createAgentStreamState counts turns from inference.done", () => {
  const state = createAgentStreamState();

  const event: ReactorEmittedEvent = {
    type: "inference.done",
    seq: 1,
    data: {
      turn: { role: "assistant", model: "test", timestamp: 0, content: [] },
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { id: "xai", model: "test" },
    } as unknown as ReactorEmittedEvent["data"],
  };

  state.addEvent(event);
  expect(state.turnsUsed).toBe(1);
});

test("createAgentStreamState accumulates cost from usage events", () => {
  const state = createAgentStreamState();

  const event: ReactorEmittedEvent = {
    type: "inference.usage",
    seq: 1,
    data: {
      usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { id: "xai", model: "test" },
    } as unknown as ReactorEmittedEvent["data"],
  };

  state.addEvent(event);
  expect(state.totalCost).toBeGreaterThan(0);
  expect(state.totalTokens).toBe(1500);
});

test("createAgentStreamState tracks status from reactor.done", () => {
  const state = createAgentStreamState();

  const event: ReactorEmittedEvent = {
    type: "reactor.done",
    seq: 1,
    data: {} as unknown as ReactorEmittedEvent["data"],
  };

  state.addEvent(event);
  expect(state.status).toBe("done");
});

test("createAgentStreamState tracks status from inference.error", () => {
  const state = createAgentStreamState();

  const event: ReactorEmittedEvent = {
    type: "inference.error",
    seq: 1,
    data: {
      error: { category: "fatal", message: "test error" },
    } as unknown as ReactorEmittedEvent["data"],
  };

  state.addEvent(event);
  expect(state.status).toBe("failed");
});

test("a received user message updates latest user message and adds a log block", () => {
  const state = createAgentStreamState();
  state.addEvent({
    type: "message.received",
    seq: 1,
    data: { message: { content: "hello world" } } as unknown as ReactorEmittedEvent["data"],
  });
  expect(state.latestUserMessage).toBe("hello world");
  expect(state.contentBlocks.length).toBe(1);
  expect(state.contentBlocks[0].type).toBe("user");
  expect(state.contentBlocks[0].content).toBe("hello world");
});

test("createAgentStreamState accumulates thinking delta tokens", () => {
  const state = createAgentStreamState();

  state.addEvent({ type: "inference.thinking.delta", seq: 1, data: { token: "H" } as unknown as ReactorEmittedEvent["data"] });
  state.addEvent({ type: "inference.thinking.delta", seq: 2, data: { token: "i" } as unknown as ReactorEmittedEvent["data"] });

  expect(state.contentBlocks.length).toBe(1);
  expect(state.contentBlocks[0].type).toBe("thinking");
  expect(state.contentBlocks[0].content).toBe("Hi");
});

test("createAgentStreamState accumulates text delta tokens", () => {
  const state = createAgentStreamState();

  state.addEvent({ type: "inference.text.delta", seq: 1, data: { token: "Hello" } as unknown as ReactorEmittedEvent["data"] });

  expect(state.contentBlocks.length).toBe(1);
  expect(state.contentBlocks[0].type).toBe("text");
  expect(state.contentBlocks[0].content).toBe("Hello");
});

test("createAgentStreamState accumulates tool_call delta fragments", () => {
  const state = createAgentStreamState();

  state.addEvent({ type: "inference.tool_call.start", seq: 1, data: { name: "read_file", callId: "c1" } as unknown as ReactorEmittedEvent["data"] });
  state.addEvent({ type: "inference.tool_call.delta", seq: 2, data: { argumentFragment: '{"path":"a"}' } as unknown as ReactorEmittedEvent["data"] });

  expect(state.contentBlocks.length).toBe(1);
  expect(state.contentBlocks[0].type).toBe("tool_call");
  expect(state.contentBlocks[0].arguments).toBe('{"path":"a"}');
});

function submitPlanEvents(callId: string, steps: Array<{ file: string; action: string; reason?: string }>): ReactorEmittedEvent[] {
  return [
    {
      type: "inference.tool_call.start",
      seq: 1,
      data: { name: "submit_plan", callId } as unknown as ReactorEmittedEvent["data"],
    },
    {
      type: "inference.tool_call.delta",
      seq: 2,
      data: { argumentFragment: JSON.stringify({ steps }) } as unknown as ReactorEmittedEvent["data"],
    },
    {
      type: "tool.done",
      seq: 3,
      data: { result: { callId, content: "ok", isError: false } } as unknown as ReactorEmittedEvent["data"],
    },
  ];
}

test("submit_plan promotes to pinned plan block at index 0", () => {
  const state = createAgentStreamState();
  for (const e of submitPlanEvents("plan-1", [
    { file: "src/a.ts", action: "create", reason: "x" },
    { file: "src/b.ts", action: "edit", reason: "y" },
  ])) {
    state.addEvent(e);
  }

  expect(state.contentBlocks.length).toBe(1);
  expect(state.contentBlocks[0].type).toBe("plan");
  const plan = state.contentBlocks[0] as { type: "plan"; steps: Array<{ file: string; action: string }> };
  expect(plan.steps).toEqual([
    { file: "src/a.ts", action: "create" },
    { file: "src/b.ts", action: "edit" },
  ]);
});

test("submit_plan does not leave a tool_call or tool_result behind", () => {
  const state = createAgentStreamState();
  for (const e of submitPlanEvents("plan-1", [{ file: "f", action: "a" }])) {
    state.addEvent(e);
  }
  expect(state.contentBlocks.some((b) => b.type === "tool_call")).toBe(false);
  expect(state.contentBlocks.some((b) => b.type === "tool_result")).toBe(false);
});

test("plan stays pinned at index 0 as new events arrive", () => {
  const state = createAgentStreamState();
  for (const e of submitPlanEvents("plan-1", [{ file: "f", action: "a" }])) {
    state.addEvent(e);
  }

  state.addEvent({
    type: "message.received",
    seq: 9,
    data: { message: { content: "now do it" } } as unknown as ReactorEmittedEvent["data"],
  });
  state.addEvent({
    type: "inference.tool_call.start",
    seq: 10,
    data: { name: "read_file", callId: "c2" } as unknown as ReactorEmittedEvent["data"],
  });
  state.addEvent({
    type: "tool.done",
    seq: 11,
    data: { result: { callId: "c2", content: "file body", isError: false } } as unknown as ReactorEmittedEvent["data"],
  });

  expect(state.contentBlocks[0].type).toBe("plan");
  expect(state.contentBlocks.filter((b) => b.type === "plan").length).toBe(1);
  expect(state.contentBlocks.length).toBeGreaterThan(1);
});

test("submit_plan with invalid arguments yields an empty plan block (no crash)", () => {
  const state = createAgentStreamState();
  state.addEvent({
    type: "inference.tool_call.start",
    seq: 1,
    data: { name: "submit_plan", callId: "p1" } as unknown as ReactorEmittedEvent["data"],
  });
  state.addEvent({
    type: "inference.tool_call.delta",
    seq: 2,
    data: { argumentFragment: "{not-json" } as unknown as ReactorEmittedEvent["data"],
  });
  state.addEvent({
    type: "tool.done",
    seq: 3,
    data: { result: { callId: "p1", content: "ok", isError: false } } as unknown as ReactorEmittedEvent["data"],
  });

  expect(state.contentBlocks[0].type).toBe("plan");
  expect((state.contentBlocks[0] as { steps: unknown[] }).steps).toEqual([]);
});

test("failed submit_plan does not create a plan block", () => {
  const state = createAgentStreamState();
  state.addEvent({
    type: "inference.tool_call.start",
    seq: 1,
    data: { name: "submit_plan", callId: "p1" } as unknown as ReactorEmittedEvent["data"],
  });
  state.addEvent({
    type: "tool.done",
    seq: 2,
    data: { result: { callId: "p1", content: "bad", isError: true } } as unknown as ReactorEmittedEvent["data"],
  });

  expect(state.contentBlocks.some((b) => b.type === "plan")).toBe(false);
});

test("createAgentStreamState tracks hook load and update events", () => {
  const state = createAgentStreamState();
  state.addHookEvent({
    type: "hooks.loaded",
    hooks: [
      {
        id: "hook-1",
        name: "one.ts",
        type: "typescript",
        path: "/tmp/one.ts",
        enabled: true,
      },
    ],
  });
  expect(state.hooks.length).toBe(1);
  expect(state.hooks[0]?.enabled).toBe(true);

  state.addHookEvent({
    type: "hook.updated",
    hook: {
      id: "hook-1",
      name: "one.ts",
      type: "typescript",
      path: "/tmp/one.ts",
      enabled: false,
      lastExitStatus: { code: 0, signal: null, stderr: "" },
    },
  });

  expect(state.hooks[0]?.enabled).toBe(false);
  expect(state.hooks[0]?.lastExitStatus?.code).toBe(0);
});

function toolCallEvents(name: string, callId: string, args: object): ReactorEmittedEvent[] {
  return [
    { type: "inference.tool_call.start", seq: 1, data: { name, callId } as unknown as ReactorEmittedEvent["data"] },
    { type: "inference.tool_call.delta", seq: 2, data: { argumentFragment: JSON.stringify(args) } as unknown as ReactorEmittedEvent["data"] },
    { type: "tool.done", seq: 3, data: { result: { callId, content: "ok", isError: false } } as unknown as ReactorEmittedEvent["data"] },
  ];
}

test("structured tool result content is normalized to a string", () => {
  const state = createAgentStreamState();
  state.addEvent({
    type: "inference.tool_call.start",
    seq: 1,
    data: { name: "web_search", callId: "web-1" } as unknown as ReactorEmittedEvent["data"],
  });
  state.addEvent({
    type: "tool.done",
    seq: 2,
    data: {
      result: {
        callId: "web-1",
        content: {
          results: [{ title: "Hono", url: "https://hono.dev", snippet: "Fast web framework" }],
        },
        isError: false,
      },
    } as unknown as ReactorEmittedEvent["data"],
  });

  const result = state.contentBlocks.at(-1);
  expect(result?.type).toBe("tool_result");
  if (result?.type !== "tool_result") return;
  expect(result.content).toContain('"results"');
  expect(result.content).toContain("https://hono.dev");
});

test("submit_plan seeds plan totals and current step", () => {
  const state = createAgentStreamState();
  for (const e of submitPlanEvents("p1", [
    { file: "src/a.ts", action: "create" },
    { file: "src/b.ts", action: "edit" },
  ])) {
    state.addEvent(e);
  }
  expect(state.planTotal).toBe(2);
  expect(state.currentPlanStep).toBe(0);
  expect(state.planDeviated).toBe(false);
});

test("write_file on the matching step advances the current plan step", () => {
  const state = createAgentStreamState();
  for (const e of submitPlanEvents("p1", [
    { file: "src/a.ts", action: "create" },
    { file: "src/b.ts", action: "edit" },
  ])) {
    state.addEvent(e);
  }
  for (const e of toolCallEvents("write_file", "w1", { path: "src/a.ts" })) {
    state.addEvent(e);
  }
  expect(state.currentPlanStep).toBe(1);
  expect(state.planDeviated).toBe(false);
});

test("edit_file on a non-matching file sets planDeviated", () => {
  const state = createAgentStreamState();
  for (const e of submitPlanEvents("p1", [{ file: "src/a.ts", action: "create" }])) {
    state.addEvent(e);
  }
  for (const e of toolCallEvents("edit_file", "w1", { path: "src/elsewhere.ts" })) {
    state.addEvent(e);
  }
  expect(state.planDeviated).toBe(true);
  expect(state.currentPlanStep).toBe(0);
});

test("a failed write does not advance the plan step", () => {
  const state = createAgentStreamState();
  for (const e of submitPlanEvents("p1", [{ file: "src/a.ts", action: "create" }, { file: "src/b.ts", action: "edit" }])) {
    state.addEvent(e);
  }
  state.addEvent({ type: "inference.tool_call.start", seq: 1, data: { name: "write_file", callId: "w1" } as unknown as ReactorEmittedEvent["data"] });
  state.addEvent({ type: "inference.tool_call.delta", seq: 2, data: { argumentFragment: JSON.stringify({ path: "src/a.ts" }) } as unknown as ReactorEmittedEvent["data"] });
  state.addEvent({ type: "tool.done", seq: 3, data: { result: { callId: "w1", content: "denied", isError: true } } as unknown as ReactorEmittedEvent["data"] });
  expect(state.currentPlanStep).toBe(0);
  expect(state.planDeviated).toBe(false);
});

test("setGatePending toggles between running and blocked", () => {
  const state = createAgentStreamState();
  expect(state.status).toBe("running");
  state.setGatePending(true);
  expect(state.status).toBe("blocked");
  state.setGatePending(false);
  expect(state.status).toBe("running");
});

test("setGatePending does not override a terminal done status", () => {
  const state = createAgentStreamState();
  state.addEvent({ type: "reactor.done", seq: 1, data: {} as unknown as ReactorEmittedEvent["data"] });
  state.setGatePending(true);
  expect(state.status).toBe("done");
});

test("awaitingResponse arms on send and clears on the first streamed token", () => {
  const state = createAgentStreamState();
  expect(state.awaitingResponse).toBe(false);

  state.markRunning();
  expect(state.awaitingResponse).toBe(true);

  state.addEvent({ type: "inference.text.delta", seq: 1, data: { token: "H" } as unknown as ReactorEmittedEvent["data"] });
  expect(state.awaitingResponse).toBe(false);
});

test("awaitingResponse re-arms after a tool result until the next token", () => {
  const state = createAgentStreamState();
  for (const e of toolCallEvents("read_file", "c1", { path: "a.ts" })) state.addEvent(e);
  // tool.done was the last event — the model is now thinking again.
  expect(state.awaitingResponse).toBe(true);

  state.addEvent({ type: "inference.text.delta", seq: 9, data: { token: "x" } as unknown as ReactorEmittedEvent["data"] });
  expect(state.awaitingResponse).toBe(false);
});

test("awaitingResponse clears when inference completes without streamed tokens", () => {
  const state = createAgentStreamState();
  for (const e of toolCallEvents("read_file", "c1", { path: "a.ts" })) state.addEvent(e);
  expect(state.awaitingResponse).toBe(true);

  state.addEvent({
    type: "inference.done",
    seq: 9,
    data: {
      turn: { role: "assistant", model: "test", timestamp: 0, content: [] },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { id: "test", model: "test" },
    } as unknown as ReactorEmittedEvent["data"],
  });

  expect(state.awaitingResponse).toBe(false);
});

test("awaitingResponse clears when the run completes", () => {
  const state = createAgentStreamState();
  state.markRunning();
  state.addEvent({ type: "reactor.done", seq: 1, data: {} as unknown as ReactorEmittedEvent["data"] });
  expect(state.awaitingResponse).toBe(false);
});

test("elapsedMs freezes after the run completes", async () => {
  const state = createAgentStreamState();
  state.addEvent({ type: "reactor.done", seq: 1, data: {} as unknown as ReactorEmittedEvent["data"] });
  const first = state.elapsedMs;
  await new Promise((r) => setTimeout(r, 5));
  expect(state.elapsedMs).toBe(first);
});
