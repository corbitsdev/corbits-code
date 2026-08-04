import { afterEach, describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";
import { clear, snapshot, type PerfSpan } from "./index.js";
import { createPerfReactorObserver } from "./reactor-spans.js";
import { createTurnContextCollector } from "../session/hooks.js";

afterEach(() => {
  clear();
});

function event(type: string, data: unknown = {}): ReactorEmittedEvent {
  return { type, seq: 1, data } as ReactorEmittedEvent;
}

function byName(spans: PerfSpan[], name: string): PerfSpan[] {
  return spans.filter((s) => s.name === name);
}

function completed(spans: PerfSpan[]): PerfSpan[] {
  return spans.filter((s) => s.endNs !== undefined);
}

const emptyUsage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, thinking: 0 };
const source = { provider: "test-provider", model: "test-model" };

function inferenceDone(content: unknown[] = [{ type: "text", text: "hi" }]): ReactorEmittedEvent {
  return event("inference.done", {
    turn: { role: "assistant", content, model: "test-model", timestamp: 0 },
    usage: emptyUsage,
    source,
  });
}

describe("createPerfReactorObserver", () => {
  test("turn nests inference with ttft and stream when deltas exist", () => {
    const obs = createPerfReactorObserver();

    obs.observe(event("inference.start", { model: "test-model" }));
    obs.observe(event("inference.text.delta", { token: "Hello", partial: { text: "Hello" } }));
    obs.observe(event("inference.text.delta", { token: " world", partial: { text: "Hello world" } }));
    obs.observe(inferenceDone());

    const spans = completed(snapshot());
    const turns = byName(spans, "turn");
    const inferences = byName(spans, "inference");
    const ttfts = byName(spans, "inference.ttft");
    const streams = byName(spans, "inference.stream");

    expect(turns).toHaveLength(1);
    expect(inferences).toHaveLength(1);
    expect(ttfts).toHaveLength(1);
    expect(streams).toHaveLength(1);

    const turn = turns[0]!;
    const inference = inferences[0]!;
    const ttft = ttfts[0]!;
    const stream = streams[0]!;

    expect(turn.parentId).toBeUndefined();
    expect(inference.parentId).toBe(turn.id);
    expect(ttft.parentId).toBe(inference.id);
    expect(stream.parentId).toBe(inference.id);

    // Ordering: ttft ends at/before stream starts; stream ends at/before inference ends.
    expect(ttft.endNs! <= stream.startNs).toBe(true);
    expect(stream.endNs! <= inference.endNs!).toBe(true);
    expect(inference.endNs! <= turn.endNs!).toBe(true);
  });

  test("tool spans nest under turn after inference.done with tool_calls", () => {
    const obs = createPerfReactorObserver();

    obs.observe(event("inference.start", { model: "test-model" }));
    obs.observe(event("inference.text.delta", { token: "x", partial: { text: "x" } }));
    obs.observe(
      inferenceDone([
        { type: "tool_call", id: "call-1", name: "run_shell", arguments: {} },
      ]),
    );
    obs.observe(event("tool.start", { call: { id: "call-1", name: "run_shell", arguments: {} } }));
    obs.observe(event("tool.done", { result: { callId: "call-1", content: "ok" } }));

    const spans = completed(snapshot());
    const turn = byName(spans, "turn")[0]!;
    const inference = byName(spans, "inference")[0]!;
    const tools = byName(spans, "tool");

    expect(tools).toHaveLength(1);
    expect(tools[0]!.parentId).toBe(turn.id);
    expect(tools[0]!.tags?.tool_id).toBe("call-1");
    expect(inference.parentId).toBe(turn.id);
    expect(turn.endNs).toBeDefined();
  });

  test("multiple turns produce separate top-level turn spans", () => {
    const obs = createPerfReactorObserver();

    for (let i = 0; i < 2; i += 1) {
      obs.observe(event("inference.start", { model: "test-model" }));
      obs.observe(event("inference.text.delta", { token: "a", partial: { text: "a" } }));
      obs.observe(inferenceDone());
    }

    const spans = completed(snapshot());
    const turns = byName(spans, "turn");
    const inferences = byName(spans, "inference");

    expect(turns).toHaveLength(2);
    expect(inferences).toHaveLength(2);
    expect(turns.every((t) => t.parentId === undefined)).toBe(true);
    expect(inferences[0]!.parentId).toBe(turns[0]!.id);
    expect(inferences[1]!.parentId).toBe(turns[1]!.id);
  });

  test("inference without stream deltas has turn + inference only (no stream)", () => {
    const obs = createPerfReactorObserver();

    obs.observe(event("inference.start", { model: "test-model" }));
    obs.observe(inferenceDone());

    const spans = completed(snapshot());
    expect(byName(spans, "turn")).toHaveLength(1);
    expect(byName(spans, "inference")).toHaveLength(1);
    // TTFT still closes at done when no first-token event arrived.
    expect(byName(spans, "inference.ttft")).toHaveLength(1);
    expect(byName(spans, "inference.stream")).toHaveLength(0);
  });

  test("thinking.delta counts as first token for TTFT", () => {
    const obs = createPerfReactorObserver();

    obs.observe(event("inference.start", { model: "test-model" }));
    obs.observe(event("inference.thinking.delta", { token: "hmm", partial: { text: "" } }));
    obs.observe(inferenceDone());

    const spans = completed(snapshot());
    expect(byName(spans, "inference.ttft")).toHaveLength(1);
    expect(byName(spans, "inference.stream")).toHaveLength(1);
  });

  test("blocked tool.done without tool.start still records a tool span", () => {
    const obs = createPerfReactorObserver();

    obs.observe(event("inference.start", { model: "test-model" }));
    obs.observe(
      inferenceDone([
        { type: "tool_call", id: "blocked-1", name: "run_shell", arguments: {} },
      ]),
    );
    obs.observe(
      event("tool.done", {
        result: { callId: "blocked-1", content: "blocked", isError: true },
      }),
    );

    const tools = byName(completed(snapshot()), "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.tags?.tool_id).toBe("blocked-1");
    expect(byName(completed(snapshot()), "turn")[0]!.endNs).toBeDefined();
  });

  test("reset closes open spans and clears state", () => {
    const obs = createPerfReactorObserver();
    obs.observe(event("inference.start", { model: "test-model" }));
    expect(snapshot().some((s) => s.endNs === undefined)).toBe(true);

    obs.reset();

    const spans = snapshot();
    expect(spans.every((s) => s.endNs !== undefined)).toBe(true);
    expect(byName(spans, "turn")).toHaveLength(1);

    // Next turn is independent.
    obs.observe(event("inference.start", { model: "test-model" }));
    obs.observe(inferenceDone());
    expect(byName(completed(snapshot()), "turn")).toHaveLength(2);
  });

  test("abandon mid-inference then new start closes prior turn with no orphans", () => {
    const obs = createPerfReactorObserver();

    obs.observe(event("inference.start", { model: "test-model" }));
    obs.observe(event("inference.text.delta", { token: "partial", partial: { text: "partial" } }));
    // Interrupt: no inference.done / error — next start must abandon.
    obs.observe(event("inference.start", { model: "test-model" }));
    obs.observe(inferenceDone());

    const spans = snapshot();
    expect(spans.every((s) => s.endNs !== undefined)).toBe(true);

    const turns = byName(completed(spans), "turn");
    const inferences = byName(completed(spans), "inference");
    expect(turns).toHaveLength(2);
    expect(inferences).toHaveLength(2);
    expect(inferences[0]!.parentId).toBe(turns[0]!.id);
    expect(inferences[1]!.parentId).toBe(turns[1]!.id);
    // First turn abandoned before second opened — not nested.
    expect(turns[0]!.endNs! <= turns[1]!.startNs).toBe(true);
  });

  test("abandon mid-tool then new start closes open tools and prior turn", () => {
    const obs = createPerfReactorObserver();

    obs.observe(event("inference.start", { model: "test-model" }));
    obs.observe(
      inferenceDone([
        { type: "tool_call", id: "call-1", name: "run_shell", arguments: {} },
      ]),
    );
    obs.observe(event("tool.start", { call: { id: "call-1", name: "run_shell", arguments: {} } }));
    // Interrupt mid-tool: no tool.done — next inference.start must not nest.
    obs.observe(event("inference.start", { model: "next-model" }));
    obs.observe(inferenceDone());

    const spans = snapshot();
    expect(spans.every((s) => s.endNs !== undefined)).toBe(true);

    const turns = byName(completed(spans), "turn");
    const tools = byName(completed(spans), "tool");
    const inferences = byName(completed(spans), "inference");

    expect(turns).toHaveLength(2);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.parentId).toBe(turns[0]!.id);
    expect(inferences).toHaveLength(2);
    expect(inferences[0]!.parentId).toBe(turns[0]!.id);
    expect(inferences[1]!.parentId).toBe(turns[1]!.id);
    // Second inference must not nest under the abandoned turn.
    expect(inferences[1]!.parentId).not.toBe(turns[0]!.id);
    expect(turns[0]!.endNs! <= turns[1]!.startNs).toBe(true);
  });

  test("inference.error mid-turn then new start leaves no open spans", () => {
    const obs = createPerfReactorObserver();

    obs.observe(event("inference.start", { model: "test-model" }));
    obs.observe(event("inference.text.delta", { token: "x", partial: { text: "x" } }));
    obs.observe(event("inference.error", { error: { message: "timeout" } }));

    // Error with no pending tools closes the turn.
    expect(snapshot().every((s) => s.endNs !== undefined)).toBe(true);

    obs.observe(event("inference.start", { model: "retry-model" }));
    obs.observe(inferenceDone());

    const spans = snapshot();
    expect(spans.every((s) => s.endNs !== undefined)).toBe(true);
    const turns = byName(completed(spans), "turn");
    expect(turns).toHaveLength(2);
    expect(byName(completed(spans), "inference")[1]!.parentId).toBe(turns[1]!.id);
  });
});

describe("turn collector durationMs unchanged with perf observer", () => {
  test("coarse durationMs still reported for a completed turn", () => {
    // createTurnContextCollector stamps cycleStartedAt on construction, then
    // inference.start re-stamps it, then completePending reads finish.
    const times = [1_000, 1_000, 1_250];
    let i = 0;
    const now = (): number => times[Math.min(i++, times.length - 1)]!;

    const completedTurns: { durationMs: number }[] = [];
    const collector = createTurnContextCollector((ctx) => {
      completedTurns.push({ durationMs: ctx.durationMs });
    }, now);
    const obs = createPerfReactorObserver();

    // Mirror the sink: both observers see the same events.
    const feed = (e: ReactorEmittedEvent): void => {
      collector.observe(e);
      obs.observe(e);
    };

    feed(event("inference.start", { model: "test-model" }));
    feed(event("inference.text.delta", { token: "hi", partial: { text: "hi" } }));
    feed(inferenceDone());

    expect(completedTurns).toHaveLength(1);
    expect(completedTurns[0]!.durationMs).toBe(250);
    expect(collector.getTurnCount()).toBe(1);

    // Perf spans still present and nested.
    const spans = completed(snapshot());
    expect(byName(spans, "turn")).toHaveLength(1);
    expect(byName(spans, "inference")).toHaveLength(1);
  });

  test("durationMs with tools waits until tool.done", () => {
    // Construction stamps cycleStartedAt, inference.start re-stamps, tool.done
    // completePending reads finish.
    const times = [5_000, 5_000, 5_400];
    let i = 0;
    const now = (): number => times[Math.min(i++, times.length - 1)]!;

    const completedTurns: { durationMs: number }[] = [];
    const collector = createTurnContextCollector((ctx) => {
      completedTurns.push({ durationMs: ctx.durationMs });
    }, now);
    const obs = createPerfReactorObserver();

    const feed = (e: ReactorEmittedEvent): void => {
      collector.observe(e);
      obs.observe(e);
    };

    feed(event("inference.start", { model: "m" }));
    feed(
      inferenceDone([
        { type: "tool_call", id: "c1", name: "read_file", arguments: {} },
      ]),
    );
    expect(completedTurns).toHaveLength(0);

    feed(event("tool.start", { call: { id: "c1", name: "read_file", arguments: {} } }));
    feed(event("tool.done", { result: { callId: "c1", content: "ok" } }));

    expect(completedTurns).toHaveLength(1);
    expect(completedTurns[0]!.durationMs).toBe(400);

    const spans = completed(snapshot());
    expect(byName(spans, "tool")).toHaveLength(1);
    expect(byName(spans, "tool")[0]!.parentId).toBe(byName(spans, "turn")[0]!.id);
  });
});
