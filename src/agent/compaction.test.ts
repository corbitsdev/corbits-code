import { describe, expect, test } from "bun:test";
import type {
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
    governor.noteInferenceDone(inferenceDone(overThreshold), 10);

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
    governor.noteInferenceDone(inferenceDone(1000), 10);
    expect(governor.interceptActions(toolDone(), inferAction, capabilities)).toBeNull();

    governor.noteInferenceDone(inferenceDone(overThreshold), 3);
    expect(governor.interceptActions(toolDone(), inferAction, capabilities)).toBeNull();
  });

  test("stays inert without a continuation channel", () => {
    const governor = createCompactionGovernor(undefined);
    governor.noteInferenceDone(inferenceDone(overThreshold), 10);
    expect(governor.interceptActions(toolDone(), inferAction, capabilities)).toBeNull();
    expect(governor.interceptOverflow(overflowError(), capabilities)).toBeNull();
  });

  test("recovers from context overflow a bounded number of times", () => {
    const governor = createCompactionGovernor(() => {});
    expect(governor.interceptOverflow(overflowError(), capabilities)).not.toBeNull();
    expect(governor.resumeAfterCompact(emptyMessage())).toBe(true);
    expect(governor.interceptOverflow(overflowError(), capabilities)).not.toBeNull();
    expect(governor.interceptOverflow(overflowError(), capabilities)).toBeNull();

    governor.noteInferenceDone(inferenceDone(1000), 10);
    expect(governor.interceptOverflow(overflowError(), capabilities)).not.toBeNull();
  });

  test("only intercepts on tool.done with a pending infer", () => {
    const governor = createCompactionGovernor(() => {});
    governor.noteInferenceDone(inferenceDone(overThreshold), 10);
    expect(governor.interceptActions(inferenceDone(overThreshold), inferAction, capabilities)).toBeNull();
    expect(governor.interceptActions(toolDone(), [{ type: "reply", content: "x" }], capabilities)).toBeNull();
  });
});
