import { describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";
import { createAgentStreamState } from "./use-stream.js";

function event(type: string, data: unknown): ReactorEmittedEvent {
  return { type, seq: 1, data } as ReactorEmittedEvent;
}

describe("createAgentStreamState", () => {
  test("captures tool_call.end arguments for manage_tasks updates", () => {
    const state = createAgentStreamState();

    state.addEvent(event("inference.tool_call.end", {
      callId: "call-1",
      name: "manage_tasks",
      arguments: {
        action: "create",
        tasks: [{ id: "t1", title: "Trace bug", status: "doing" }],
      },
    }));
    state.addEvent(event("tool.done", {
      result: { callId: "call-1", content: "ok", isError: false },
    }));

    expect(state.tasks).toEqual([{ id: "t1", title: "Trace bug", status: "doing" }]);
    expect(state.contentBlocks.some((block) => block.type === "tasks")).toBe(true);
    expect(state.contentBlocks.some((block) => block.type === "tool_call" && block.name === "manage_tasks")).toBe(false);
  });

  test("streams text deltas into the active text block", () => {
    const state = createAgentStreamState();

    state.addEvent(event("inference.text.delta", { token: "hel" }));
    state.addEvent(event("inference.text.delta", { token: "lo" }));

    expect(state.streamingType).toBe("text");
    expect(state.awaitingResponse).toBe(false);
    expect(state.contentBlocks).toMatchObject([{ type: "text", content: "hello" }]);
  });

  test("caps the retained block tail and reports the trimmed count", () => {
    const state = createAgentStreamState();

    // Drive well past the retention cap with distinct tool_call/result pairs so
    // every event pushes a fresh block rather than appending to the last one.
    for (let i = 0; i < 1200; i++) {
      state.addEvent(event("inference.tool_call.end", {
        callId: `call-${i}`,
        name: "read_file",
        arguments: { path: `f${i}.ts` },
      }));
      state.addEvent(event("tool.done", {
        result: { callId: `call-${i}`, content: `result ${i}`, isError: false },
      }));
    }

    expect(state.contentBlocks.length).toBeLessThanOrEqual(2000);
    expect(state.trimmedBlockCount).toBeGreaterThan(0);
    // The most recent work is always retained; the oldest is what gets dropped.
    const last = state.contentBlocks.at(-1);
    expect(last?.type).toBe("tool_result");
  });

  test("surfaces the active tool while a tool call is running", () => {
    const state = createAgentStreamState();

    state.addEvent(event("inference.tool_call.end", {
      callId: "call-2",
      name: "run_shell",
      arguments: { command: "bun test" },
    }));

    expect(state.currentToolName).toBe("run_shell");
    expect(state.streamingType).toBe("tool");
  });

  test("tracks sub-agent task calls separately from managed tasks", () => {
    const state = createAgentStreamState();

    state.addEvent(event("inference.tool_call.end", {
      callId: "call-3",
      name: "task",
      arguments: { agent: "greybeard", description: "review correctness", prompt: "..." },
    }));

    expect(state.subAgents).toEqual([{ id: "call-3", title: "greybeard: review correctness", status: "doing" }]);
    expect(state.tasks).toEqual([]);

    state.addEvent(event("tool.done", {
      result: { callId: "call-3", content: "ok", isError: false },
    }));

    expect(state.subAgents).toEqual([{ id: "call-3", title: "greybeard: review correctness", status: "done" }]);
  });

  test("labels sub-agents without a named profile as worker", () => {
    const state = createAgentStreamState();

    state.addEvent(event("inference.tool_call.end", {
      callId: "call-4",
      name: "task",
      arguments: { description: "map callers of X", prompt: "..." },
    }));

    expect(state.subAgents).toEqual([{ id: "call-4", title: "worker: map callers of X", status: "doing" }]);
  });

  test("requestStop clears quota wait after quota_exhausted inference.error", () => {
    const state = createAgentStreamState();
    state.markRunning();
    state.addEvent(event("inference.error", {
      error: { category: "quota_exhausted", message: "rate limited", retryAfterMs: 5000 },
    }));

    expect(state.status).toBe("failed");
    expect(state.quotaError).not.toBeNull();

    state.requestStop();

    expect(state.quotaError).toBeNull();
    expect(state.status).toBe("stopped");
    expect(state.isProcessing).toBe(false);
  });
});
