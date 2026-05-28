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

test("createAgentStreamState accumulates user messages", () => {
  const state = createAgentStreamState();
  state.addUserMessage("hello world");
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
