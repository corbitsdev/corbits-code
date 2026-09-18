// CL-8220 regression tests: the compact path must always return to dequeue,
// even when the summary call hangs, and back-to-back threshold compactions
// must complete without operator action.
import { describe, expect, test } from "bun:test";
import type {
  Compactor,
  ConversationTurn,
  StrategyContext,
  StrategyResult,
} from "@intx/types/runtime";

import {
  COMPACTION_ABORTED_REASON,
  createCompactionEventNotices,
  createCompactionLifecycle,
} from "./compaction-lifecycle.js";
import { createModelSummarizer } from "./summarizer.js";
import type { Telemetry } from "../telemetry/index.js";

const ctx = {} as unknown as StrategyContext;

function turns(count: number): ConversationTurn[] {
  return Array.from({ length: count }, (_, i) => ({
    role: "user",
    content: [{ type: "text", text: `turn ${i}` }],
    timestamp: i,
  })) as ConversationTurn[];
}

function okResult(
  output: ConversationTurn[],
): StrategyResult<ConversationTurn[]> {
  return {
    output,
    record: {
      strategy: "inner",
      version: "0",
      parameters: {},
      reason: "folded",
      decisions: { summarizedTurnCount: 3 },
    },
  };
}

function hangingCompactor(): Compactor {
  return {
    name: "hang",
    version: "0",
    apply: () =>
      new Promise<StrategyResult<ConversationTurn[]>>(() => {
        // Never settles on purpose: the abort race must win.
      }),
  };
}

describe("createCompactionLifecycle", () => {
  test("a hanging compact resolves promptly on abort with input unchanged", async () => {
    const events: string[] = [];
    const tracked = createCompactionLifecycle({
      onCompactionStart: () => events.push("start"),
      onCompactionEnd: (info) => events.push(`end:${info.aborted}`),
    });
    const wrapped = tracked.wrapCompactor(hangingCompactor());
    const input = turns(10);
    const pending = wrapped.apply(input, ctx);
    expect(tracked.isCompacting()).toBe(true);
    tracked.abortCompaction("operator interrupt");
    const result = await pending;
    expect(tracked.isCompacting()).toBe(false);
    expect(result.output).toBe(input);
    expect(result.blobs ?? []).toEqual([]);
    expect(result.record.reason).toBe(COMPACTION_ABORTED_REASON);
    expect(events).toEqual(["start", "end:true"]);
  });

  test("abort before start skips the inner run without lifecycle events", async () => {
    let calls = 0;
    const inner: Compactor = {
      name: "inner",
      version: "0",
      apply: async (input) => {
        calls += 1;
        return okResult(input);
      },
    };
    const events: string[] = [];
    const lifecycle = createCompactionLifecycle({
      onCompactionStart: () => events.push("start"),
      onCompactionEnd: () => events.push("end"),
    });
    lifecycle.abortCompaction("operator interrupt");
    const input = turns(4);
    const result = await lifecycle.wrapCompactor(inner).apply(input, ctx);
    expect(calls).toBe(0);
    expect(result.output).toBe(input);
    expect(result.record.reason).toBe(COMPACTION_ABORTED_REASON);
    expect(events).toEqual([]);
    expect(lifecycle.isCompacting()).toBe(false);
  });

  test("a completing compact passes through with end-not-aborted", async () => {
    const inner: Compactor = {
      name: "inner",
      version: "1",
      apply: async (input) => okResult(input.slice(-2)),
    };
    const ends: boolean[] = [];
    const lifecycle = createCompactionLifecycle({
      onCompactionEnd: (info) => ends.push(info.aborted),
    });
    const wrapped = lifecycle.wrapCompactor(inner);
    expect(wrapped.name).toBe("inner");
    const result = await wrapped.apply(turns(8), ctx);
    expect(result.output).toHaveLength(2);
    expect(result.record.reason).toBe("folded");
    expect(ends).toEqual([false]);
    expect(lifecycle.isCompacting()).toBe(false);
  });

  test("a genuine inner failure still propagates (never masked as abort)", async () => {
    const inner: Compactor = {
      name: "inner",
      version: "0",
      apply: async () => {
        throw new Error("store exploded");
      },
    };
    const ends: boolean[] = [];
    const lifecycle = createCompactionLifecycle({
      onCompactionEnd: (info) => ends.push(info.aborted),
    });
    await expect(
      lifecycle.wrapCompactor(inner).apply(turns(3), ctx),
    ).rejects.toThrow("store exploded");
    expect(ends).toEqual([false]);
    expect(lifecycle.isCompacting()).toBe(false);
  });

  test("back-to-back compactions complete and the loop keeps going", async () => {
    let calls = 0;
    const inner: Compactor = {
      name: "inner",
      version: "0",
      apply: async (input) => {
        calls += 1;
        return okResult(input);
      },
    };
    const lifecycle = createCompactionLifecycle();
    const wrapped = lifecycle.wrapCompactor(inner);
    const first = turns(12);
    const firstResult = await wrapped.apply(first, ctx);
    expect(lifecycle.isCompacting()).toBe(false);
    const secondResult = await wrapped.apply(firstResult.output, ctx);
    expect(lifecycle.isCompacting()).toBe(false);
    // A third pass (the post-compact inference turn's threshold re-check)
    // still runs: nothing wedged the loop.
    await wrapped.apply(secondResult.output, ctx);
    expect(calls).toBe(3);
  });

  test("two compactions, then interrupt-during-compact, then resend works", async () => {
    let hang = false;
    let releaseHang: (() => void) | undefined;
    const inner: Compactor = {
      name: "inner",
      version: "0",
      apply: (input) =>
        hang
          ? new Promise<StrategyResult<ConversationTurn[]>>((resolve) => {
              releaseHang = () => resolve(okResult(input));
            })
          : Promise.resolve(okResult(input)),
    };
    const lifecycle = createCompactionLifecycle();
    const wrapped = lifecycle.wrapCompactor(inner);
    // Two threshold compactions complete normally…
    await wrapped.apply(turns(10), ctx);
    await wrapped.apply(turns(10), ctx);
    // …then a third hangs and the operator interrupts mid-compact…
    hang = true;
    const input = turns(10);
    const pending = wrapped.apply(input, ctx);
    expect(lifecycle.isCompacting()).toBe(true);
    lifecycle.abortCompaction("operator interrupt");
    const interrupted = await pending;
    expect(interrupted.output).toBe(input);
    expect(interrupted.record.reason).toBe(COMPACTION_ABORTED_REASON);
    // …the rebuild mints a fresh signal and the resent turn compacts fine.
    lifecycle.reset();
    hang = false;
    const resent = await wrapped.apply(turns(10), ctx);
    expect(resent.record.reason).not.toBe(COMPACTION_ABORTED_REASON);
    expect(releaseHang).toBeDefined();
  });

  test("event notices announce the pass and only speak up on abort", () => {
    const notices: string[] = [];
    const events = createCompactionEventNotices((text) => {
      notices.push(text);
    });
    events.onCompactionStart?.();
    expect(notices).toHaveLength(1);
    events.onCompactionEnd?.({ aborted: false });
    expect(notices).toHaveLength(1);
    events.onCompactionEnd?.({ aborted: true });
    expect(notices).toHaveLength(2);
  });

  test("reset mints a fresh signal so the next agent is not pre-aborted", async () => {
    const lifecycle = createCompactionLifecycle();
    const before = lifecycle.getSignal();
    lifecycle.abortCompaction("operator interrupt");
    expect(before.aborted).toBe(true);
    lifecycle.reset();
    const after = lifecycle.getSignal();
    expect(after.aborted).toBe(false);
    expect(after).not.toBe(before);
  });

  test("interrupt-during-compact emits one non-failure notice and no telemetry", async () => {
    const notices: string[] = [];
    const lifecycle = createCompactionLifecycle(
      createCompactionEventNotices((text) => {
        notices.push(text);
      }),
    );
    const telemetryEvents: string[] = [];
    const telemetry: Telemetry = {
      enabled: true,
      installationId: "test",
      capture: (event) => {
        telemetryEvents.push(event);
      },
      captureIntentional: () => false,
      flush: async () => undefined,
      discard: () => undefined,
    };
    const summarize = createModelSummarizer({
      getSource: () =>
        ({
          id: "test",
          provider: "test",
          model: "test",
          credentialId: "test",
        }) as never,
      getSignal: () => lifecycle.getSignal(),
      telemetry,
      onFailure: (text) => {
        notices.push(text);
      },
      complete: (_promptTurns, _source, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const err = new Error("aborted by lifecycle");
              err.name = "AbortError";
              reject(err);
            },
            { once: true },
          );
        }),
    });
    const inner: Compactor = {
      name: "inner",
      version: "0",
      apply: async (input) => {
        const text = await summarize(input);
        return okResult([
          ...input.slice(-1),
          {
            ...(input[0] as ConversationTurn),
            timestamp: -1,
            content: [{ type: "text", text }],
          } as ConversationTurn,
        ]);
      },
    };
    const wrapped = lifecycle.wrapCompactor(inner);
    const input = turns(10);
    const pending = wrapped.apply(input, ctx);
    expect(lifecycle.isCompacting()).toBe(true);
    lifecycle.abortCompaction("operator interrupt");
    const result = await pending;
    expect(result.output).toBe(input);
    expect(result.record.reason).toBe(COMPACTION_ABORTED_REASON);
    // Exactly the lifecycle's own two notices: start + interrupted. The
    // summarizer's "Compaction summary failed … (aborted by lifecycle)"
    // failure framing must stay silent on a lifecycle abort.
    expect(notices).toEqual([
      "Compacting conversation context…",
      "Compaction interrupted — keeping prior context.",
    ]);
    expect(notices.some((n) => n.includes("Compaction summary failed"))).toBe(
      false,
    );
    expect(telemetryEvents).toEqual([]);
  });

  test("a genuine summarizer failure still notifies and emits telemetry", async () => {
    const notices: string[] = [];
    const captured: {
      event: string;
      properties?: Record<string, unknown> | undefined;
    }[] = [];
    const telemetry: Telemetry = {
      enabled: true,
      installationId: "test",
      capture: (event, properties) => {
        captured.push({ event, properties });
      },
      captureIntentional: () => false,
      flush: async () => undefined,
      discard: () => undefined,
    };
    const summarize = createModelSummarizer({
      getSource: () =>
        ({
          id: "test",
          provider: "test",
          model: "test",
          credentialId: "test",
        }) as never,
      telemetry,
      onFailure: (text) => {
        notices.push(text);
      },
      complete: async () => {
        throw new Error("model unreachable");
      },
    });
    await expect(summarize(turns(5))).rejects.toThrow("model unreachable");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Compaction summary failed");
    const failures = captured.filter((e) => e.event === "summarizer_failure");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.properties?.["error_kind"]).toBe("failed");
  });

  test("the summarizer honors the lifecycle signal via getSignal", async () => {
    const lifecycle = createCompactionLifecycle();
    const seen: AbortSignal[] = [];
    const summarize = createModelSummarizer({
      getSource: () =>
        ({
          id: "test",
          provider: "test",
          model: "test",
          credentialId: "test",
        }) as never,
      getSignal: () => lifecycle.getSignal(),
      complete: async (_promptTurns, _source, signal) => {
        seen.push(signal);
        if (signal.aborted) throw new Error("aborted by lifecycle");
        return "summary";
      },
    });
    lifecycle.abortCompaction("operator interrupt");
    await expect(summarize(turns(5))).rejects.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(true);
  });
});
