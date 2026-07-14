import { describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { ConversationTurn } from "@intx/types/runtime";
import { createTurnContextCollector, RETAINED_TURN_CONTEXT_LIMIT } from "../session/hooks.js";
import {
  MAX_RETAINED_TRANSCRIPT_BYTES,
  MAX_STORED_ASSISTANT_BLOCK_CHARS,
  MAX_STORED_TOOL_ARGUMENT_CHARS,
  MAX_STORED_TOOL_RESULT_CHARS,
  capStoredToolResultContent,
  createAgentStreamState,
  settleSubAgentOnToolResult,
  type ContentBlockData,
} from "./use-stream.js";
import { turnsToContentBlocks } from "./turns-to-blocks.js";

function event(type: string, data: unknown): ReactorEmittedEvent {
  return { type, seq: 1, data } as ReactorEmittedEvent;
}

describe("createAgentStreamState", () => {
  test("waits for every parallel tool before awaiting another response", () => {
    const state = createAgentStreamState();

    state.addEvent(event("inference.tool_call.start", { callId: "fast", name: "read_file" }));
    state.addEvent(event("inference.tool_call.start", { callId: "slow", name: "run_shell" }));
    state.addEvent(event("tool.done", {
      result: { callId: "fast", content: "done", isError: false },
    }));

    expect(state.awaitingResponse).toBe(false);

    state.addEvent(event("tool.done", {
      result: { callId: "slow", content: "done", isError: false },
    }));

    expect(state.awaitingResponse).toBe(true);
  });

  test("surfaces present view validation errors as tool_result", () => {
    const state = createAgentStreamState();
    state.addEvent(event("inference.tool_call.end", {
      callId: "present-1",
      name: "present",
      arguments: { view: { type: "not-a-primitive" } },
    }));
    state.addEvent(event("tool.done", {
      result: { callId: "present-1", content: "ok", isError: false },
    }));
    const err = state.contentBlocks.find((b) => b.type === "tool_result" && b.isError);
    expect(err).toMatchObject({
      type: "tool_result",
      name: "present",
      isError: true,
    });
    expect(String((err as { content: string }).content)).toContain("present view validation failed");
  });

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

  test("joins fragmented text into a single settled block", () => {
    const state = createAgentStreamState();

    const fragments = Array.from({ length: 5_000 }, (_, i) => `f${i} `);
    for (const fragment of fragments) {
      state.addEvent(event("inference.text.delta", { token: fragment }));
    }

    const block = state.contentBlocks.find((b) => b.type === "text");
    expect(block?.type).toBe("text");
    if (block?.type !== "text") return;
    expect(block.content).toBe(fragments.join(""));
  });

  test("joins fragmented reasoning into a single settled block", () => {
    const state = createAgentStreamState();

    const fragments = Array.from({ length: 5_000 }, (_, i) => `r${i} `);
    for (const fragment of fragments) {
      state.addEvent(event("inference.thinking.delta", { token: fragment }));
    }

    const block = state.contentBlocks.find((b) => b.type === "thinking");
    expect(block?.type).toBe("thinking");
    if (block?.type !== "thinking") return;
    expect(block.content).toBe(fragments.join(""));
  });

  test("accumulates fragmented tool arguments in one place", () => {
    const state = createAgentStreamState();

    state.addEvent(event("inference.tool_call.start", { callId: "call-args", name: "run_shell" }));
    const pieces = ['{"comm', 'and":"', "echo ", 'hi"}'];
    for (const piece of pieces) {
      state.addEvent(event("inference.tool_call.delta", { argumentFragment: piece }));
    }

    const streamed = state.contentBlocks.find((b) => b.type === "tool_call");
    expect(streamed?.type).toBe("tool_call");
    if (streamed?.type !== "tool_call") return;
    expect(streamed.arguments).toBe('{"command":"echo hi"}');

    state.addEvent(event("inference.tool_call.end", { callId: "call-args", name: "run_shell" }));
    state.addEvent(event("tool.done", {
      result: { callId: "call-args", content: "hi", isError: false },
    }));

    const result = state.contentBlocks.find((b) => b.type === "tool_result");
    expect(result?.type).toBe("tool_result");
  });

  test("ingesting fragments scales near-linearly with fragment count", () => {
    const runFragments = (count: number): number => {
      const state = createAgentStreamState();
      const start = performance.now();
      for (let i = 0; i < count; i++) {
        state.addEvent(event("inference.text.delta", { token: "abcd " }));
        // Drain once per batch, as the display loop does — this is where a
        // per-fragment concat would turn quadratic.
        void state.contentBlocks.length;
      }
      void state.contentBlocks.length;
      return performance.now() - start;
    };

    const base = Math.max(runFragments(20_000), 1);
    const quadruple = runFragments(80_000);
    // Quadratic ingestion would push this ratio toward 16x; linear stays near
    // 4x. A generous ceiling keeps the guard meaningful without flaking on CI.
    expect(quadruple / base).toBeLessThan(10);
  });

  test("caps a multi-megabyte non-streamed reply", () => {
    const state = createAgentStreamState();
    const huge = "z".repeat(5_000_000);

    state.addEvent(event("connector.reply", { content: huge }));

    const block = state.contentBlocks.find((b) => b.type === "text");
    expect(block?.type).toBe("text");
    if (block?.type !== "text") return;
    expect(block.content.length).toBeLessThanOrEqual(MAX_STORED_ASSISTANT_BLOCK_CHARS);
    expect(block.content).toContain("characters omitted from stored assistant text");
  });

  test("settles retained content under the byte budget for a huge history", () => {
    const state = createAgentStreamState();

    const chunk = "y".repeat(MAX_STORED_TOOL_RESULT_CHARS);
    for (let i = 0; i < 500; i++) {
      state.addEvent(event("inference.tool_call.end", {
        callId: `call-${i}`,
        name: "read_file",
        arguments: { path: `f${i}.ts` },
      }));
      state.addEvent(event("tool.done", {
        result: { callId: `call-${i}`, content: chunk, isError: false },
      }));
    }

    const retainedBytes = state.contentBlocks.reduce((sum, b) => {
      if (b.type === "tool_result" || b.type === "text" || b.type === "thinking") return sum + b.content.length;
      if (b.type === "tool_call") return sum + b.arguments.length;
      return sum;
    }, 0);
    expect(retainedBytes).toBeLessThanOrEqual(MAX_RETAINED_TRANSCRIPT_BYTES);
    expect(state.trimmedBlockCount).toBeGreaterThan(0);
    expect(state.contentBlocks.at(-1)?.type).toBe("tool_result");
  });

  test("caps resumed assistant text and releases the original payload after hydration", () => {
    // Tool blocks arrive already capped from the producer, so hydration only
    // owns the assistant text/thinking caps the producer leaves untouched.
    const initial: ContentBlockData[] = [
      { type: "text", content: "t".repeat(MAX_STORED_ASSISTANT_BLOCK_CHARS + 50_000) },
    ];

    const state = createAgentStreamState([], undefined, initial);

    // The hydration payload is drained so its large strings can be reclaimed.
    expect(initial).toHaveLength(0);

    const text = state.contentBlocks.find((b) => b.type === "text");
    expect(text?.type === "text" && text.content.length).toBeLessThanOrEqual(MAX_STORED_ASSISTANT_BLOCK_CHARS);
    expect(text?.type === "text" && text.content).toContain("characters omitted from stored assistant text");
  });

  test("hydrating an oversized resumed tool result keeps a single omission marker", () => {
    // Regression: the producer tail-caps tool_result content, and hydration
    // must not re-cap it. A second cap cut through the first omission marker,
    // yielding a false "… 2 characters omitted" and a garbled marker header.
    const turns: ConversationTurn[] = [{
      role: "assistant",
      content: [
        { type: "tool_call", id: "c1", name: "run_shell", arguments: { command: "ls" } },
        { type: "tool_result", callId: "c1", content: [{ type: "text", text: "b".repeat(MAX_STORED_TOOL_RESULT_CHARS + 50_000) }], isError: false },
      ],
      model: "test",
      timestamp: 0,
    }];

    const initial = turnsToContentBlocks(turns);
    const state = createAgentStreamState([], undefined, initial);

    const result = state.contentBlocks.find((b) => b.type === "tool_result");
    const content = result?.type === "tool_result" ? result.content : "";
    const markerCount = content.split("characters omitted from stored tool output").length - 1;
    expect(markerCount).toBe(1);
    expect(content).not.toContain("… 2 characters omitted");
    expect(content.length).toBeLessThanOrEqual(MAX_STORED_TOOL_RESULT_CHARS);
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

    // Failed sub-agents drop from the strip like successes; only non-terminal
    // entries (doing) would remain.
    expect(state.subAgents).toEqual([]);
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

  test("inference.retry drops sub-agent strip entries for rolled-back tool calls", () => {
    const state = createAgentStreamState();
    state.markRunning();
    state.addEvent(event("inference.start", {}));
    state.addEvent(event("inference.tool_call.end", {
      callId: "task-rolled-back",
      name: "task",
      arguments: { agent: "critique", description: "review branch", prompt: "..." },
    }));
    expect(state.subAgents).toEqual([
      { id: "task-rolled-back", title: "critique: review branch", status: "doing" },
    ]);

    // Retry rewinds to the attempt boundary: the streamed task call never ran.
    state.addEvent(event("inference.retry", {}));
    expect(state.subAgents).toEqual([]);
  });

  test("requestStop drops in-flight sub-agent strip entries", () => {
    const state = createAgentStreamState();
    state.markRunning();
    state.addEvent(event("inference.tool_call.end", {
      callId: "task-aborted",
      name: "task",
      arguments: { agent: "critique", description: "review branch", prompt: "..." },
    }));
    expect(state.subAgents).toHaveLength(1);

    state.requestStop();
    expect(state.subAgents).toEqual([]);
  });

  test("settleSubAgentOnToolResult clears strip when name map is lost", () => {
    // Simulate the mid-flight state where callId→name was wiped (retry / partial
    // bookkeeping) but the Agents fallback still holds a "doing" entry.
    const agents = [
      { id: "call-lost-name", title: "critique: Re-review CL-3460 branch", status: "doing" as const },
    ];
    const next = settleSubAgentOnToolResult(
      agents,
      "call-lost-name",
      undefined, // name map miss → toolName unknown
      false,
      "critique: Re-review CL-3460 branch",
    );
    expect(next).toEqual([]);
  });

  test("settleSubAgentOnToolResult ignores unrelated tool results", () => {
    const agents = [
      { id: "call-task", title: "worker: map", status: "doing" as const },
    ];
    const next = settleSubAgentOnToolResult(agents, "other-call", "run_shell", false, "worker");
    expect(next).toEqual(agents);
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

  test("requestStop finalizes an in-flight tool_call so it stops rendering as running", () => {
    const state = createAgentStreamState();
    state.markRunning();
    state.addEvent(event("inference.tool_call.start", { callId: "call-live", name: "run_shell" }));

    // The call has no result yet — it would spin forever if the abort left it be.
    expect(state.contentBlocks.some((b) => b.type === "tool_result" && b.callId === "call-live")).toBe(false);

    state.requestStop();

    const result = state.contentBlocks.find((b) => b.type === "tool_result" && b.callId === "call-live");
    expect(result?.type).toBe("tool_result");
    expect(result?.type === "tool_result" && result.isError).toBe(true);
    // Every tool_call now has a matching result: nothing is left pending.
    const calls = state.contentBlocks.filter((b) => b.type === "tool_call");
    for (const call of calls) {
      const callId = call.type === "tool_call" ? (call.callId ?? call.id) : "";
      expect(state.contentBlocks.some((b) => b.type === "tool_result" && b.callId === callId)).toBe(true);
    }
  });

  test("reactor.error finalizes an outstanding tool_call", () => {
    const state = createAgentStreamState();
    state.markRunning();
    state.addEvent(event("inference.tool_call.start", { callId: "call-err", name: "read_file" }));
    state.addEvent(event("reactor.error", { fatal: true, error: "boom" }));

    expect(state.status).toBe("failed");
    expect(state.contentBlocks.some((b) => b.type === "tool_result" && b.callId === "call-err")).toBe(true);
  });

  test("finalizing does not double-resolve a call that already completed", () => {
    const state = createAgentStreamState();
    state.markRunning();
    state.addEvent(event("inference.tool_call.start", { callId: "call-done", name: "read_file" }));
    state.addEvent(event("tool.done", { result: { callId: "call-done", content: "ok", isError: false } }));

    state.requestStop();

    const results = state.contentBlocks.filter((b) => b.type === "tool_result" && b.callId === "call-done");
    expect(results).toHaveLength(1);
    expect(results[0]?.type === "tool_result" && results[0].isError).toBe(false);
  });

  test("a duplicate tool.done for the same callId does not push a second tool_result block", () => {
    // Regression: the reactor's retry loop can re-emit a completed cycle's
    // tool.done alongside the retried cycle's own tool.done for the same
    // call, which previously produced two tool_result blocks for one call.
    const state = createAgentStreamState();
    state.addEvent(event("inference.tool_call.start", { callId: "call-dup", name: "read_file" }));
    state.addEvent(event("tool.done", { result: { callId: "call-dup", content: "first", isError: false } }));
    state.addEvent(event("tool.done", { result: { callId: "call-dup", content: "first", isError: false } }));

    const results = state.contentBlocks.filter((b) => b.type === "tool_result" && b.callId === "call-dup");
    expect(results).toHaveLength(1);
  });

  test("inference.retry discards the blocks streamed by the failed attempt", () => {
    // Regression: the reactor restarts inferenceRunner from scratch on a
    // same-source or failover retry, re-streaming inference.start through
    // whatever content the failed attempt already committed. inference.retry
    // is the marker the reactor emits before restarting; the transcript must
    // roll back to the attempt boundary so the retried attempt's own content
    // is not appended on top of the discarded one.
    const state = createAgentStreamState();
    state.addEvent(event("inference.start", { model: "test-model" }));
    state.addEvent(event("inference.text.delta", { token: "partial reply from the failed attempt" }));
    state.addEvent(event("inference.retry", { attempt: 1, delayMs: 0, previousError: { category: "quota_exhausted", message: "429" } }));
    state.addEvent(event("inference.start", { model: "test-model" }));
    state.addEvent(event("inference.text.delta", { token: "final reply" }));

    const textBlocks = state.contentBlocks.filter((b) => b.type === "text");
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]?.type === "text" && textBlocks[0].content).toBe("final reply");
  });

  test("a harness pre-commit inference.retry does not splice away the previous cycle's blocks", () => {
    // The harness emits inference.retry for uncommitted attempts, discarding
    // the failed attempt's buffered inference.start — so the event reaches
    // the TUI before any inference.start for its cycle. At that moment the
    // rollback boundary still describes the previous, completed cycle;
    // splicing there would destroy settled text and tool results.
    const state = createAgentStreamState();
    // Cycle 1 completes normally with text and a tool result.
    state.addEvent(event("inference.start", { model: "test-model" }));
    state.addEvent(event("inference.text.delta", { token: "settled reply" }));
    state.addEvent(event("inference.tool_call.start", { callId: "call-1", name: "read_file" }));
    state.addEvent(event("inference.tool_call.end", { callId: "call-1", name: "read_file", arguments: { path: "a.txt" } }));
    state.addEvent(event("inference.done", { turn: { role: "assistant", content: [], model: "test-model", timestamp: 0 }, usage: {}, source: {} }));
    state.addEvent(event("tool.done", { result: { callId: "call-1", content: "ok", isError: false } }));

    // Cycle 2's first attempt fails pre-commit: harness-style retry arrives
    // before the cycle's inference.start.
    state.addEvent(event("inference.retry", { attempt: 1, delayMs: 0, previousError: { category: "retryable", message: "5xx" } }));
    state.addEvent(event("inference.start", { model: "test-model" }));
    state.addEvent(event("inference.text.delta", { token: "second reply" }));

    const textBlocks = state.contentBlocks.filter((b) => b.type === "text");
    expect(textBlocks.map((b) => b.type === "text" && b.content)).toEqual(["settled reply", "second reply"]);
    expect(state.contentBlocks.filter((b) => b.type === "tool_result" && b.callId === "call-1")).toHaveLength(1);
  });

  test("a cycle ended by inference.error does not leave the rollback boundary armed", () => {
    // A cycle can terminate in inference.error with no inference.done (user
    // abort, fatal, exhausted failover). The boundary must not stay armed
    // across that terminal error: a later cycle's pre-commit harness retry
    // would otherwise splice away the aborted partial, the rendered error
    // block, and any user message pushed in between.
    const state = createAgentStreamState();
    state.markRunning();
    state.addEvent(event("inference.start", { model: "test-model" }));
    state.addEvent(event("inference.text.delta", { token: "aborted partial" }));
    state.addEvent(event("inference.error", { error: { category: "aborted", message: "Esc" }, partial: { text: "aborted partial" } }));

    state.addEvent(event("message.received", { message: { content: "please continue" } }));

    // Cycle 2's first attempt fails pre-commit: harness retry before start.
    state.addEvent(event("inference.retry", { attempt: 1, delayMs: 0, previousError: { category: "retryable", message: "5xx" } }));
    state.addEvent(event("inference.start", { model: "test-model" }));
    state.addEvent(event("inference.text.delta", { token: "second reply" }));

    const texts = state.contentBlocks.filter((b) => b.type === "text").map((b) => b.type === "text" && b.content);
    expect(texts).toEqual(["aborted partial", "second reply"]);
    expect(state.contentBlocks.filter((b) => b.type === "user")).toHaveLength(1);
  });

  test("an inference.retry immediately after a committed inference.error still rolls back", () => {
    // The reactor's committed-retry path surfaces the failed attempt's
    // inference.error and then its own inference.retry back to back; the
    // rollback must still retract the failed attempt in that shape.
    const state = createAgentStreamState();
    state.addEvent(event("inference.start", { model: "test-model" }));
    state.addEvent(event("inference.text.delta", { token: "failed attempt" }));
    state.addEvent(event("inference.error", { error: { category: "quota_exhausted", message: "429" }, partial: { text: "failed attempt" } }));
    state.addEvent(event("inference.retry", { attempt: 1, delayMs: 1, previousError: { category: "quota_exhausted", message: "429" } }));
    state.addEvent(event("inference.start", { model: "test-model" }));
    state.addEvent(event("inference.text.delta", { token: "final reply" }));

    const texts = state.contentBlocks.filter((b) => b.type === "text").map((b) => b.type === "text" && b.content);
    expect(texts).toEqual(["final reply"]);
  });

  test("a callId reused across cycles renders both results", () => {
    // Index-based providers synthesize callIds unique only within a cycle
    // ("0", "1", ...), so tool.done dedup must reset at each inference.start.
    const state = createAgentStreamState();
    state.addEvent(event("inference.start", { model: "test-model" }));
    state.addEvent(event("inference.tool_call.start", { callId: "1", name: "read_file" }));
    state.addEvent(event("tool.done", { result: { callId: "1", content: "first cycle", isError: false } }));

    state.addEvent(event("inference.start", { model: "test-model" }));
    state.addEvent(event("inference.tool_call.start", { callId: "1", name: "run_shell" }));
    state.addEvent(event("tool.done", { result: { callId: "1", content: "second cycle", isError: false } }));

    const results = state.contentBlocks.filter((b) => b.type === "tool_result" && b.callId === "1");
    expect(results).toHaveLength(2);
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

  test("a retryable inference error does not fail the run or finalize in-flight tool calls", () => {
    const state = createAgentStreamState();
    state.markRunning();
    state.addEvent(event("inference.tool_call.start", { callId: "call-1", name: "run_shell" }));
    state.addEvent(event("inference.tool_call.end", { callId: "call-1", name: "run_shell" }));

    state.addEvent(event("inference.error", { error: { category: "retryable", message: "transient" } }));

    expect(state.status).not.toBe("failed");
    // The in-flight call must stay resultless so a retry does not paint it as aborted.
    expect(state.contentBlocks.some((b) => b.type === "tool_result")).toBe(false);
  });

  test("a fatal reactor error fails the run and finalizes in-flight tool calls", () => {
    const state = createAgentStreamState();
    state.markRunning();
    state.addEvent(event("inference.tool_call.start", { callId: "call-1", name: "run_shell" }));
    state.addEvent(event("inference.tool_call.end", { callId: "call-1", name: "run_shell" }));

    state.addEvent(event("reactor.error", { fatal: true, error: "boom" }));

    expect(state.status).toBe("failed");
    const result = state.contentBlocks.find((b) => b.type === "tool_result");
    expect(result?.type === "tool_result" && result.isError).toBe(true);
  });

  test("collapses submit_plan and manage_tasks into plan and tasks blocks on resume", () => {
    const turns: ConversationTurn[] = [{
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "plan-1",
          name: "submit_plan",
          arguments: { steps: [{ file: "src/a.ts", action: "edit" }] },
        },
        { type: "tool_result", callId: "plan-1", content: [{ type: "text", text: "ok" }], isError: false },
        {
          type: "tool_call",
          id: "tasks-1",
          name: "manage_tasks",
          arguments: { action: "create", tasks: [{ id: "t1", title: "Ship fix" }] },
        },
        { type: "tool_result", callId: "tasks-1", content: [{ type: "text", text: "ok" }], isError: false },
      ],
      model: "test",
      timestamp: 0,
    }];

    const blocks = turnsToContentBlocks(turns);
    expect(blocks.some((b) => b.type === "tool_call" && b.name === "submit_plan")).toBe(false);
    expect(blocks.some((b) => b.type === "tool_call" && b.name === "manage_tasks")).toBe(false);
    const plan = blocks.find((b) => b.type === "plan");
    expect(plan?.type === "plan" && plan.steps).toEqual([{ file: "src/a.ts", action: "edit" }]);
    const taskBlock = blocks.find((b) => b.type === "tasks");
    expect(taskBlock?.type === "tasks" && taskBlock.tasks).toEqual([
      { id: "t1", title: "Ship fix", status: "todo" },
    ]);

    const state = createAgentStreamState();
    state.hydrateHistory(blocks);
    expect(state.tasks).toEqual([{ id: "t1", title: "Ship fix", status: "todo" }]);
  });

  test("caps stringified tool results and arguments from a resume transcript", () => {
    const turns: ConversationTurn[] = [{
      role: "assistant",
      content: [
        { type: "tool_call", id: "c1", name: "run_shell", arguments: { command: "a".repeat(MAX_STORED_TOOL_ARGUMENT_CHARS + 50_000) } },
        { type: "tool_result", callId: "c1", content: [{ type: "text", text: "b".repeat(MAX_STORED_TOOL_RESULT_CHARS + 50_000) }], isError: false },
      ],
      model: "test",
      timestamp: 0,
    }];

    const blocks = turnsToContentBlocks(turns);
    const call = blocks.find((b) => b.type === "tool_call");
    expect(call?.type === "tool_call" && call.arguments.length).toBeLessThanOrEqual(MAX_STORED_TOOL_ARGUMENT_CHARS);
    const result = blocks.find((b) => b.type === "tool_result");
    expect(result?.type === "tool_result" && result.content).toContain("characters omitted from stored tool output");
  });
});
