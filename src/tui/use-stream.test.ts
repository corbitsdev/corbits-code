import { describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { ConversationTurn } from "@intx/types/runtime";
import { createTurnContextCollector, RETAINED_TURN_CONTEXT_LIMIT } from "../session/hooks.js";
import {
  MAX_STORED_TOOL_RESULT_CHARS,
  capStoredToolResultContent,
  createAgentStreamState,
} from "./use-stream.js";
import { turnsToContentBlocks } from "./turns-to-blocks.js";

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

  test("caps oversized tool results at ingress", () => {
    const state = createAgentStreamState();
    const huge = "x".repeat(MAX_STORED_TOOL_RESULT_CHARS + 5_000);

    state.addEvent(event("inference.tool_call.end", {
      callId: "call-huge",
      name: "read_file",
      arguments: { path: "big.txt" },
    }));
    state.addEvent(event("tool.done", {
      result: { callId: "call-huge", content: huge, isError: false },
    }));

    const result = state.contentBlocks.find((b) => b.type === "tool_result");
    expect(result?.type).toBe("tool_result");
    if (result?.type !== "tool_result") return;
    expect(result.content.length).toBeLessThan(huge.length);
    expect(result.content).toContain("characters omitted from stored tool output");
    // Tail-anchored: the suffix of a long shell dump is what the user needs
    // (exit codes, totals) — verify the tail survives and the head is dropped.
    expect(result.content.endsWith(huge.slice(-200))).toBe(true);
    expect(capStoredToolResultContent(huge).length).toBeLessThan(huge.length);
  });

  test("streaming text cap appends an omission marker on the crossing frame", () => {
    const state = createAgentStreamState();
    const callId = "stream-text";
    const tokenA = "a".repeat(100);
    const tokenB = "b".repeat(200_000);

    state.addEvent(event("inference.text.delta", { token: tokenA }));
    // Second token blows well past MAX_STORED_ASSISTANT_BLOCK_CHARS.
    state.addEvent(event("inference.text.delta", { token: tokenB }));
    state.addEvent(event("inference.text.delta", { token: "ignored tail" }));

    const block = state.contentBlocks.find((b) => b.type === "text");
    expect(block?.type).toBe("text");
    if (block?.type !== "text") return;
    expect(block.content).toContain("additional streaming content omitted");
    expect(block.content.endsWith("ignored tail")).toBe(false);
  });

  test("caps the retained block tail and reports the trimmed count", () => {
    const state = createAgentStreamState();

    // Drive well past the retention cap with distinct tool_call/result pairs so
    // every event pushes a fresh block rather than appending to the last one.
    for (let i = 0; i < 400; i++) {
      state.addEvent(event("inference.tool_call.end", {
        callId: `call-${i}`,
        name: "read_file",
        arguments: { path: `f${i}.ts` },
      }));
      state.addEvent(event("tool.done", {
        result: { callId: `call-${i}`, content: `result ${i}`, isError: false },
      }));
    }

    expect(state.contentBlocks.length).toBeLessThanOrEqual(600);
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

  test("latestUserMessageLogged is true after message.received and resets on clear", () => {
    const state = createAgentStreamState();

    expect(state.latestUserMessageLogged).toBe(true);

    state.clear();
    state.addEvent(event("message.received", { message: { content: "hello" } }));

    expect(state.latestUserMessage).toBe("hello");
    expect(state.latestUserMessageLogged).toBe(true);

    state.clear();
    expect(state.latestUserMessage).toBe("");
    expect(state.latestUserMessageLogged).toBe(true);
  });

  test("hookCount returns the number of hooks without allocating a snapshot", () => {
    const state = createAgentStreamState([
      { id: "h1", name: "lint.ts", type: "typescript", path: "/hooks/lint.ts", enabled: true },
      { id: "h2", name: "fmt.sh", type: "shell", path: "/hooks/fmt.sh", enabled: false },
    ]);

    expect(state.hookCount).toBe(2);
  });

  test("hooks getter returns a cached snapshot across reads", () => {
    const state = createAgentStreamState([
      { id: "h1", name: "lint.ts", type: "typescript", path: "/hooks/lint.ts", enabled: true },
    ]);

    const first = state.hooks;
    const second = state.hooks;
    // Same reference — not re-allocated on every access.
    expect(first).toBe(second);

    state.addHookEvent({ type: "hook.updated", hook: { id: "h1", name: "lint.ts", type: "typescript", path: "/hooks/lint.ts", enabled: false, lastFiredAt: 123 } });
    const afterUpdate = state.hooks;
    expect(afterUpdate).not.toBe(first);
    expect(afterUpdate[0]?.enabled).toBe(false);
  });
});

describe("createTurnContextCollector", () => {
  test("retains a bounded tail while preserving the total turn count", () => {
    const collector = createTurnContextCollector(() => {});

    for (let i = 0; i < RETAINED_TURN_CONTEXT_LIMIT + 5; i++) {
      collector.observe(event("inference.done", {
        turn: {
          role: "assistant",
          content: [{ type: "text", text: `turn ${i}` }],
          model: "test",
          timestamp: i,
        },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        source: { provider: "test", model: "test" },
      }));
    }

    expect(collector.getTurnCount()).toBe(RETAINED_TURN_CONTEXT_LIMIT + 5);
    expect(collector.getTurns()).toHaveLength(RETAINED_TURN_CONTEXT_LIMIT);
    expect(collector.getTurns()[0]?.turnIndex).toBe(5);
  });
});

describe("turnsToContentBlocks", () => {
  test("hydrates only the retained tail when a resume transcript is capped", () => {
    const turns: ConversationTurn[] = Array.from({ length: 5 }, (_, i) => ({
      role: "user",
      content: [{ type: "text", text: `message ${i}` }],
      timestamp: i,
    }));

    expect(turnsToContentBlocks(turns, { maxBlocks: 2 })).toEqual([
      { type: "user", content: "message 3" },
      { type: "user", content: "message 4" },
    ]);
  });
});
