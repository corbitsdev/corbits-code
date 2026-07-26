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

function inferenceDoneWithoutUsage(): Extract<ReactorInboundEvent, { type: "inference.done" }> {
  return {
    type: "inference.done",
    turn: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    usage: usage(0),
    source: { sourceId: "s", provider: "p", model: "m" },
  } as unknown as Extract<ReactorInboundEvent, { type: "inference.done" }>;
}

function inferenceDoneMissingUsage(): Extract<ReactorInboundEvent, { type: "inference.done" }> {
  return {
    type: "inference.done",
    turn: { role: "assistant", content: [{ type: "text", text: "ok" }] },
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

  test("arms from the running local estimate when usage is zero", () => {
    const governor = createCompactionGovernor(() => {});
    const overThresholdChars = (compactionThresholdFor("m") + 1) * 4;
    const turns = turnsOfLength(10, Math.ceil(overThresholdChars / 10));
    governor.noteInferenceDone(inferenceDoneWithoutUsage(), turns);

    const actions = governor.interceptActions(toolDone(), inferAction, capabilities);
    expect(actions).not.toBeNull();
    expect(actions?.some((a) => a.type === "compact")).toBe(true);
  });

  test("arms from the running local estimate when usage is omitted", () => {
    const governor = createCompactionGovernor(() => {});
    const overThresholdChars = (compactionThresholdFor("m") + 1) * 4;
    const turns = turnsOfLength(10, Math.ceil(overThresholdChars / 10));
    governor.noteInferenceDone(inferenceDoneMissingUsage(), turns);

    expect(governor.interceptActions(toolDone(), inferAction, capabilities)).not.toBeNull();
  });

  test("stays inert when usage is missing but the accumulated estimate is small", () => {
    const governor = createCompactionGovernor(() => {});
    governor.noteInferenceDone(inferenceDoneWithoutUsage(), turnsOfLength(10, 4));
    expect(governor.interceptActions(toolDone(), inferAction, capabilities)).toBeNull();
  });

  test("arms from accumulated growth across many turns when usage is absent", () => {
    // A single turn's content stays well under the threshold; only the sum
    // across a long conversation crosses it. Measuring the latest turn alone
    // would never arm here.
    const governor = createCompactionGovernor(() => {});
    const perTurnChars = 2000;
    const turns = turnsOfLength(200, perTurnChars);
    governor.noteInferenceDone(inferenceDoneWithoutUsage(), turns);

    const actions = governor.interceptActions(toolDone(), inferAction, capabilities);
    expect(actions).not.toBeNull();
    expect(actions?.some((a) => a.type === "compact")).toBe(true);
  });

  test("prefers provider usage over the local estimate when usage is present", () => {
    const governor = createCompactionGovernor(() => {});
    // Local estimate is huge; reported usage is small. Prefer the provider.
    const hugeTurns = turnsOfLength(200, 2000);
    governor.noteInferenceDone(inferenceDone(1000), hugeTurns);
    expect(governor.interceptActions(toolDone(), inferAction, capabilities)).toBeNull();

    // Provider reports over threshold with a small local estimate → arm.
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(governor.interceptActions(toolDone(), inferAction, capabilities)).not.toBeNull();
  });

  test("syncFromTurns keeps the running estimate current outside arming", () => {
    const governor = createCompactionGovernor(() => {});
    expect(governor.estimatedTokens).toBe(0);

    const turns = turnsOfLength(4, 40);
    expect(governor.syncFromTurns(turns)).toBe(40); // 4 turns * 10 tokens
    expect(governor.estimatedTokens).toBe(40);

    // A rewrite (compaction) shrinks without needing inference.done.
    expect(governor.syncFromTurns(turnsOfLength(1, 8))).toBe(2);
    expect(governor.estimatedTokens).toBe(2);
  });

  test("only intercepts on tool.done with a pending infer", () => {
    const governor = createCompactionGovernor(() => {});
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(governor.interceptActions(inferenceDone(overThreshold), inferAction, capabilities)).toBeNull();
    expect(governor.interceptActions(toolDone(), [{ type: "reply", content: "x" }], capabilities)).toBeNull();
  });
});
