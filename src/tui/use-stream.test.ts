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

  test("hydrateHistory prepends resumed transcript ahead of live blocks", () => {
    const state = createAgentStreamState();

    // A block streamed into the fresh transcript before history lands.
    state.addEvent(event("inference.text.delta", { token: "live" }));

    state.hydrateHistory([
      { type: "user", content: "first" },
      { type: "text", content: "past reply" },
    ]);

    expect(state.contentBlocks.map((b) => b.type)).toEqual(["user", "text", "text"]);
    expect(state.contentBlocks[0]).toMatchObject({ type: "user", content: "first" });
    expect(state.contentBlocks[1]).toMatchObject({ type: "text", content: "past reply" });
    expect(state.contentBlocks[2]).toMatchObject({ type: "text", content: "live" });
  });

  test("hydrateHistory caps resumed history at the retention limit", () => {
    const state = createAgentStreamState();

    // Resume a transcript larger than the retained tail. The old serial-pushBlock
    // path trimmed as it seeded; prepending must enforce the same 600-block cap
    // immediately, not defer it to the first post-resume push.
    const resumed = Array.from({ length: 2000 }, (_, i) => ({
      type: "text" as const,
      content: `turn ${i}`,
    }));
    state.hydrateHistory(resumed);

    expect(state.contentBlocks.length).toBe(600);
    expect(state.trimmedBlockCount).toBe(1400);
    // The most recent turns survive; the oldest are dropped from the front.
    expect(state.contentBlocks[0]).toMatchObject({ content: "turn 1400" });
    expect(state.contentBlocks.at(-1)).toMatchObject({ content: "turn 1999" });

    // A first post-resume message must not trigger a mass collapse: the cap was
    // already enforced, so only the single incremental trim applies.
    const trimmedBefore = state.trimmedBlockCount;
    state.addEvent(event("message.received", { message: { content: "hello" } }));
    expect(state.trimmedBlockCount).toBe(trimmedBefore + 1);
    expect(state.contentBlocks.length).toBe(600);
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

    // Completed sub-agents are never rendered, so they are pruned rather than
    // retained for the rest of the session.
    expect(state.subAgents).toEqual([]);
  });

  test("noteSubAgentProgress updates status tool name and agents strip annotation", () => {
    const state = createAgentStreamState();

    state.addEvent(event("inference.tool_call.end", {
      callId: "call-progress",
      name: "task",
      arguments: { agent: "greybeard", description: "map callers", prompt: "..." },
    }));

    const blocksBefore = state.contentBlocks.length;
    state.noteSubAgentProgress({ description: "map callers", toolName: "grep" });

    expect(state.currentToolName).toBe("grep");
    expect(state.streamingType).toBe("tool");
    expect(state.subAgents).toEqual([
      { id: "call-progress", title: "greybeard: map callers · grep", status: "doing" },
    ]);
    // Progress must not inject sub-agent transcript into the parent content.
    expect(state.contentBlocks.length).toBe(blocksBefore);

    state.noteSubAgentProgress({ description: "map callers", toolName: "read_file" });
    expect(state.subAgents[0]?.title).toBe("greybeard: map callers · read_file");
    expect(state.currentToolName).toBe("read_file");
  });

  test("keeps failed sub-agent calls but prunes ones that finish cleanly", () => {
    const state = createAgentStreamState();

    for (let i = 0; i < 200; i++) {
      state.addEvent(event("inference.tool_call.end", {
        callId: `sub-${i}`,
        name: "task",
        arguments: { agent: "worker", description: `job ${i}`, prompt: "..." },
      }));
      state.addEvent(event("tool.done", {
        result: { callId: `sub-${i}`, content: "ok", isError: i === 199 },
      }));
    }

    // Only the failed sub-agent (status "todo") survives; the rest were
    // pruned on completion instead of accumulating for the whole session.
    expect(state.subAgents).toEqual([{ id: "sub-199", title: "worker: job 199", status: "todo" }]);
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

  test("appendUserMessage shows input immediately and message.received does not duplicate the block", () => {
    const state = createAgentStreamState();

    state.appendUserMessage("hello world");
    expect(state.latestUserMessage).toBe("hello world");
    expect(state.latestUserMessageLogged).toBe(true);
    expect(state.contentBlocks.filter((b) => b.type === "user")).toHaveLength(1);
    expect(state.contentBlocks.at(-1)).toMatchObject({ type: "user", content: "hello world" });

    // Simulates the event arriving after a delayed deliver (e.g. token refresh).
    state.addEvent(event("message.received", { message: { content: "hello world" } }));
    // Still exactly one user block; no duplicate.
    expect(state.contentBlocks.filter((b) => b.type === "user")).toHaveLength(1);

    // A different message still appends.
    state.addEvent(event("message.received", { message: { content: "second" } }));
    expect(state.contentBlocks.filter((b) => b.type === "user")).toHaveLength(2);
    expect(state.contentBlocks.at(-1)).toMatchObject({ type: "user", content: "second" });
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
