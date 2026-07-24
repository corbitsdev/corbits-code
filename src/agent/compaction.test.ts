import { describe, expect, test } from "bun:test";
import type {
  ConversationTurn,
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
  TokenUsage,
} from "@intx/types/runtime";
import { createCompactionGovernor } from "./compaction.js";
import { compactionThresholdFor } from "../provider/context-window.js";

const capabilities = {
  infer: (options?: unknown) => ({ type: "infer", ...(options !== undefined ? { options } : {}) }),
  compact: (compactor: string, reason: string) => ({ type: "compact", compactor, reason }),
} as unknown as ReactorCapabilities;

function usage(input: number): TokenUsage {
  return { input, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
}

function turnsOfLength(count: number, textLength: number): ConversationTurn[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: "x".repeat(textLength) }],
    timestamp: i,
  })) as unknown as ConversationTurn[];
}

function inferenceDone(input: number): Extract<ReactorInboundEvent, { type: "inference.done" }> {
  return {
    type: "inference.done",
    turn: { role: "assistant", content: [] },
    usage: usage(input),
    source: { sourceId: "s", provider: "p", model: "m" },
  } as unknown as Extract<ReactorInboundEvent, { type: "inference.done" }>;
}

function inferenceDoneWithoutUsage(
  textLength: number,
): Extract<ReactorInboundEvent, { type: "inference.done" }> {
  return {
    type: "inference.done",
    turn: { role: "assistant", content: [{ type: "text", text: "x".repeat(textLength) }] },
    usage: usage(0),
    source: { sourceId: "s", provider: "p", model: "m" },
  } as unknown as Extract<ReactorInboundEvent, { type: "inference.done" }>;
}

function toolDone(): ReactorInboundEvent {
  return {
    type: "tool.done",
    result: { callId: "c1", content: "ok" },
  } as ReactorInboundEvent;
}

function emptyMessage(): ReactorInboundEvent {
  return {
    type: "message.received",
    message: { content: "" },
  } as ReactorInboundEvent;
}

function overflowError(): ReactorInboundEvent {
  return {
    type: "inference.error",
    error: { category: "context_overflow", message: "too big" },
    partial: { text: "" },
  } as ReactorInboundEvent;
}

const overThreshold = compactionThresholdFor("m") + 1;
const inferAction: ReactorAction[] = [{ type: "infer" }];
const tenTurns = turnsOfLength(10, 1);
const threeTurns = turnsOfLength(3, 1);

describe("compaction governor", () => {
  test("swaps the post-tool infer for a compact action once the threshold is crossed", () => {
    let continuations = 0;
    const governor = createCompactionGovernor(() => continuations++);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);

    const actions = governor.interceptActions(toolDone(), inferAction, capabilities);
    expect(actions).not.toBeNull();
    expect(actions?.some((a) => a.type === "compact")).toBe(true);
    expect(actions?.some((a) => a.type === "infer")).toBe(false);
    expect(continuations).toBe(1);

    expect(governor.resumeAfterCompact(emptyMessage())).toBe(true);
    expect(governor.resumeAfterCompact(emptyMessage())).toBe(false);
  });

  test("stays inert below the threshold or with few turns", () => {
    const governor = createCompactionGovernor(() => {});
    governor.noteInferenceDone(inferenceDone(1000), tenTurns);
    expect(governor.interceptActions(toolDone(), inferAction, capabilities)).toBeNull();

    governor.noteInferenceDone(inferenceDone(overThreshold), threeTurns);
    expect(governor.interceptActions(toolDone(), inferAction, capabilities)).toBeNull();
  });

  test("stays inert without a continuation channel", () => {
    const governor = createCompactionGovernor(undefined);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(governor.interceptActions(toolDone(), inferAction, capabilities)).toBeNull();
    expect(governor.interceptOverflow(overflowError(), capabilities)).toBeNull();
  });

  test("recovers from context overflow a bounded number of times", () => {
    const governor = createCompactionGovernor(() => {});
    expect(governor.interceptOverflow(overflowError(), capabilities)).not.toBeNull();
    expect(governor.resumeAfterCompact(emptyMessage())).toBe(true);
    expect(governor.interceptOverflow(overflowError(), capabilities)).not.toBeNull();
    expect(governor.interceptOverflow(overflowError(), capabilities)).toBeNull();

    governor.noteInferenceDone(inferenceDone(1000), tenTurns);
    expect(governor.interceptOverflow(overflowError(), capabilities)).not.toBeNull();
  });

  test("an idle over-threshold turn requests a continuation and compacts on its arrival", () => {
    let continuations = 0;
    const governor = createCompactionGovernor(() => continuations++);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);

    const terminal: ReactorAction[] = [{ type: "reply", content: "done" }];
    governor.noteIdleTurn(inferenceDone(overThreshold), terminal);
    expect(continuations).toBe(1);
    // Only asked once even if the idle turn is observed again.
    governor.noteIdleTurn(inferenceDone(overThreshold), terminal);
    expect(continuations).toBe(1);

    const actions = governor.interceptIdleContinuation(emptyMessage(), capabilities);
    expect(actions).toEqual([
      { type: "compact", compactor: "pruning-compactor", reason: "context-threshold" },
    ] as ReactorAction[]);
    // The continuation was consumed; nothing further is intercepted.
    expect(governor.interceptIdleContinuation(emptyMessage(), capabilities)).toBeNull();
  });

  test("an operator message that races the idle continuation still compacts, then re-infers", () => {
    let continuations = 0;
    const governor = createCompactionGovernor(() => continuations++);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    governor.noteIdleTurn(inferenceDone(overThreshold), [{ type: "reply", content: "done" }]);

    const raced = {
      type: "message.received",
      message: { content: "next question" },
    } as ReactorInboundEvent;
    const actions = governor.interceptIdleContinuation(raced, capabilities);
    expect(actions?.some((a) => a.type === "compact")).toBe(true);
    // A second continuation is requested so the operator message gets answered
    // after the compact cycle.
    expect(continuations).toBe(2);
    expect(governor.resumeAfterCompact(emptyMessage())).toBe(true);
  });

  test("idle turns with follow-up work or under threshold never arm idle compaction", () => {
    let continuations = 0;
    const governor = createCompactionGovernor(() => continuations++);

    governor.noteIdleTurn(inferenceDone(1000), [{ type: "reply", content: "x" }]);
    expect(continuations).toBe(0);

    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    governor.noteIdleTurn(inferenceDone(overThreshold), [
      { type: "reply", content: "x" },
      { type: "infer" },
    ]);
    expect(continuations).toBe(0);
    expect(governor.interceptIdleContinuation(emptyMessage(), capabilities)).toBeNull();
  });

  test("estimates context size from accumulated turn content when usage is missing and arms compaction", () => {
    const governor = createCompactionGovernor(() => {});
    const overThresholdChars = (compactionThresholdFor("m") + 1) * 4;
    const turns = turnsOfLength(10, Math.ceil(overThresholdChars / 10));
    governor.noteInferenceDone(inferenceDoneWithoutUsage(1), turns);

    const actions = governor.interceptActions(toolDone(), inferAction, capabilities);
    expect(actions).not.toBeNull();
    expect(actions?.some((a) => a.type === "compact")).toBe(true);
  });

  test("stays inert when usage is missing but the accumulated content is small", () => {
    const governor = createCompactionGovernor(() => {});
    governor.noteInferenceDone(inferenceDoneWithoutUsage(4), turnsOfLength(10, 4));
    expect(governor.interceptActions(toolDone(), inferAction, capabilities)).toBeNull();
  });

  test("arms compaction from accumulated growth across many turns when usage is absent", () => {
    // A single turn's content (a realistic reply or tool result) stays well
    // under the threshold; only the sum across a long conversation crosses
    // it. Measuring `event.turn` alone (the bug this governor must avoid)
    // would never arm here.
    const governor = createCompactionGovernor(() => {});
    const perTurnChars = 2000;
    const turns = turnsOfLength(200, perTurnChars);
    governor.noteInferenceDone(inferenceDoneWithoutUsage(perTurnChars), turns);

    const actions = governor.interceptActions(toolDone(), inferAction, capabilities);
    expect(actions).not.toBeNull();
    expect(actions?.some((a) => a.type === "compact")).toBe(true);
  });

  test("only intercepts on tool.done with a pending infer", () => {
    const governor = createCompactionGovernor(() => {});
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(governor.interceptActions(inferenceDone(overThreshold), inferAction, capabilities)).toBeNull();
    expect(governor.interceptActions(toolDone(), [{ type: "reply", content: "x" }], capabilities)).toBeNull();
  });
});
