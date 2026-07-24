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

function inferenceDone(input: number): Extract<ReactorInboundEvent, { type: "inference.done" }> {
  return {
    type: "inference.done",
    turn: { role: "assistant", content: [] },
    usage: usage(input),
    source: { sourceId: "s", provider: "p", model: "m" },
  } as unknown as Extract<ReactorInboundEvent, { type: "inference.done" }>;
}

function turn(role: ConversationTurn["role"], content: ConversationTurn["content"] = [{ type: "text", text: "" }]): ConversationTurn {
  return { role, content, timestamp: Date.now() };
}

// N plain text turns, none carrying an image -- the baseline "nothing to age" shape.
function plainTurns(n: number): ConversationTurn[] {
  return Array.from({ length: n }, (_, i) => turn(i % 2 === 0 ? "user" : "assistant"));
}

const imageBlock = {
  type: "image" as const,
  source: { kind: "base64" as const, mimeType: "image/png", data: "iVBORw0KGgo=" },
};

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

describe("compaction governor", () => {
  test("swaps the post-tool infer for a compact action once the threshold is crossed", () => {
    let continuations = 0;
    const governor = createCompactionGovernor(() => continuations++);
    governor.noteInferenceDone(inferenceDone(overThreshold), plainTurns(10));

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
    governor.noteInferenceDone(inferenceDone(1000), plainTurns(10));
    expect(governor.interceptActions(toolDone(), inferAction, capabilities)).toBeNull();

    governor.noteInferenceDone(inferenceDone(overThreshold), plainTurns(3));
    expect(governor.interceptActions(toolDone(), inferAction, capabilities)).toBeNull();
  });

  test("stays inert without a continuation channel", () => {
    const governor = createCompactionGovernor(undefined);
    governor.noteInferenceDone(inferenceDone(overThreshold), plainTurns(10));
    expect(governor.interceptActions(toolDone(), inferAction, capabilities)).toBeNull();
    expect(governor.interceptOverflow(overflowError(), capabilities)).toBeNull();
  });

  test("recovers from context overflow a bounded number of times", () => {
    const governor = createCompactionGovernor(() => {});
    expect(governor.interceptOverflow(overflowError(), capabilities)).not.toBeNull();
    expect(governor.resumeAfterCompact(emptyMessage())).toBe(true);
    expect(governor.interceptOverflow(overflowError(), capabilities)).not.toBeNull();
    expect(governor.interceptOverflow(overflowError(), capabilities)).toBeNull();

    governor.noteInferenceDone(inferenceDone(1000), plainTurns(10));
    expect(governor.interceptOverflow(overflowError(), capabilities)).not.toBeNull();
  });

  test("an idle over-threshold turn requests a continuation and compacts on its arrival", () => {
    let continuations = 0;
    const governor = createCompactionGovernor(() => continuations++);
    governor.noteInferenceDone(inferenceDone(overThreshold), plainTurns(10));

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
    governor.noteInferenceDone(inferenceDone(overThreshold), plainTurns(10));
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

    governor.noteInferenceDone(inferenceDone(overThreshold), plainTurns(10));
    governor.noteIdleTurn(inferenceDone(overThreshold), [
      { type: "reply", content: "x" },
      { type: "infer" },
    ]);
    expect(continuations).toBe(0);
    expect(governor.interceptIdleContinuation(emptyMessage(), capabilities)).toBeNull();
  });

  test("only intercepts on tool.done with a pending infer", () => {
    const governor = createCompactionGovernor(() => {});
    governor.noteInferenceDone(inferenceDone(overThreshold), plainTurns(10));
    expect(governor.interceptActions(inferenceDone(overThreshold), inferAction, capabilities)).toBeNull();
    expect(governor.interceptActions(toolDone(), [{ type: "reply", content: "x" }], capabilities)).toBeNull();
  });
});

describe("compaction governor — image aging without a pruning pass", () => {
  test("arms the image-aging compactor once an image-bearing turn leaves the recent window, even far below the token threshold", () => {
    const governor = createCompactionGovernor(() => {}, 2);
    const turns = [
      turn("user", [{ type: "text", text: "here's a screenshot" }, imageBlock]),
      ...plainTurns(4),
    ];
    // Well under the size threshold that would otherwise gate compaction.
    governor.noteInferenceDone(inferenceDone(1000), turns);

    const actions = governor.interceptActions(toolDone(), inferAction, capabilities);
    expect(actions).toEqual([
      { type: "compact", compactor: "image-aging-compactor", reason: "image-aging" },
    ] as ReactorAction[]);
  });

  test("does not arm image aging while the image-bearing turn is still within the recent window", () => {
    const governor = createCompactionGovernor(() => {}, 2);
    const turns = [
      ...plainTurns(2),
      turn("user", [{ type: "text", text: "here's a screenshot" }, imageBlock]),
    ];
    governor.noteInferenceDone(inferenceDone(1000), turns);
    expect(governor.interceptActions(toolDone(), inferAction, capabilities)).toBeNull();
  });

  test("prefers the pruning compactor when both the token threshold and an ageable image fire together", () => {
    const governor = createCompactionGovernor(() => {}, 2);
    const turns = [
      turn("user", [{ type: "text", text: "here's a screenshot" }, imageBlock]),
      ...plainTurns(10),
    ];
    governor.noteInferenceDone(inferenceDone(overThreshold), turns);

    const actions = governor.interceptActions(toolDone(), inferAction, capabilities);
    expect(actions).toEqual([
      { type: "compact", compactor: "pruning-compactor", reason: "context-threshold" },
    ] as ReactorAction[]);
  });

  test("an idle turn with an ageable image also requests a continuation and compacts on arrival", () => {
    let continuations = 0;
    const governor = createCompactionGovernor(() => continuations++, 2);
    const turns = [
      turn("user", [{ type: "text", text: "here's a screenshot" }, imageBlock]),
      ...plainTurns(4),
    ];
    governor.noteInferenceDone(inferenceDone(1000), turns);
    governor.noteIdleTurn(inferenceDone(1000), [{ type: "reply", content: "done" }]);
    expect(continuations).toBe(1);

    const actions = governor.interceptIdleContinuation(emptyMessage(), capabilities);
    expect(actions).toEqual([
      { type: "compact", compactor: "image-aging-compactor", reason: "image-aging" },
    ] as ReactorAction[]);
  });
});
