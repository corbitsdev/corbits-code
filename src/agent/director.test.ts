import { describe, expect, test } from "bun:test";
import type {
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
  ReactorState,
} from "@intx/types/runtime";
import { createChatDirector } from "./director.js";

const mockState: ReactorState = { turns: [] } as unknown as ReactorState;

function makeCapabilities(): ReactorCapabilities {
  return {
    infer: (options) =>
      ({ type: "infer", ...(options !== undefined ? { options } : {}) }) as ReactorAction,
    executeTools: (calls, parallel, addToHistory) =>
      ({ type: "execute_tools", calls, parallel, addToHistory }) as ReactorAction,
    suspend: (gate) => ({ type: "suspend", gate }) as ReactorAction,
    fork: (mode, forkId) => ({ type: "fork", mode, forkId }) as ReactorAction,
    emit: (eventType, data) => ({ type: "emit", eventType, data }) as ReactorAction,
    reply: (content) => ({ type: "reply", content }) as ReactorAction,
    checkpoint: (message = "") => ({ type: "checkpoint", message }) as ReactorAction,
    compact: (compactor, reason) => ({ type: "compact", compactor, reason }) as ReactorAction,
    wait: () => ({ type: "wait" }) as ReactorAction,
    done: () => ({ type: "done" }) as ReactorAction,
  };
}

// Varied arguments per call so the fingerprint changes turn to turn — the
// shape of genuine, varied tool-only orchestration (Linear lookups, reading
// different files, ...), as opposed to repeatedToolOnlyTurn below.
function toolOnlyTurn(id: string): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      model: "test",
      timestamp: 0,
      content: [{ type: "tool_call", id, name: "read_file", arguments: { path: `${id}.ts` } }],
    },
    usage: { input: 0, output: 0 },
    source: "test",
  } as unknown as ReactorInboundEvent;
}

// Identical tool name + arguments on every call regardless of id — the shape
// of genuine no-progress thrash (fingerprintToolCalls ignores call id).
function repeatedToolOnlyTurn(id: string): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      model: "test",
      timestamp: 0,
      content: [{ type: "tool_call", id, name: "read_file", arguments: { path: "a.ts" } }],
    },
    usage: { input: 0, output: 0 },
    source: "test",
  } as unknown as ReactorInboundEvent;
}

function toolDoneEvent(callId: string): ReactorInboundEvent {
  return {
    type: "tool.done",
    result: { callId, content: "ok" },
  } as unknown as ReactorInboundEvent;
}

function actionsArray(result: ReactorAction | ReactorAction[]): ReactorAction[] {
  return Array.isArray(result) ? result : [result];
}

function ephemeralText(action: ReactorAction | undefined): string | undefined {
  if (action === undefined || action.type !== "infer") return undefined;
  const opts = action.options as
    { ephemeralTurns?: { content: { text?: string }[] }[] } | undefined;
  return opts?.ephemeralTurns?.[0]?.content?.[0]?.text;
}

// Drive N consecutive tool-only turns (tool_call -> tool.done -> tool_call -> ...).
async function runToolOnlyStreak(
  director: ReturnType<typeof createChatDirector>,
  capabilities: ReactorCapabilities,
  count: number,
  makeTurn: (id: string) => ReactorInboundEvent = toolOnlyTurn,
): Promise<ReactorAction[]> {
  let last: ReactorAction[] = [];
  for (let i = 0; i < count; i++) {
    const id = `tc-${i}`;
    await director.decide(makeTurn(id), mockState, capabilities);
    last = actionsArray(await director.decide(toolDoneEvent(id), mockState, capabilities));
  }
  return last;
}

describe("ChatDirector tool-only loop protection", () => {
  const providerlessPolicy = { providerName: "test-provider" };

  test("nudges once at the family threshold, after pending tools execute", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    // Default family nudges at 25 consecutive tool-only turns.
    const actions = await runToolOnlyStreak(director, capabilities, 25);
    const infer = actions.find((a) => a.type === "infer");
    expect(infer).toBeDefined();
    expect(ephemeralText(infer)).toBeDefined();
  });

  test("the nudge is one-shot — it does not repeat on the next tool-only turn", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    await runToolOnlyStreak(director, capabilities, 25);
    const nextTurn = actionsArray(await runToolOnlyStreak(director, capabilities, 1));
    const infer = nextTurn.find((a) => a.type === "infer");
    expect(infer).toBeDefined();
    expect(ephemeralText(infer)).toBeUndefined();
  });

  // A long productive tool-only streak (varied fingerprints every turn) must
  // run straight through the nudge without ever pausing.
  test("a long productive tool-only streak continues without pausing", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    const actions = await runToolOnlyStreak(director, capabilities, 50);
    expect(actions.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(
      false,
    );
    expect(actions.some((a) => a.type === "infer")).toBe(true);
  });

  // CL-6995: the main-session tool-fingerprint thrash pause and the
  // turns-since-user-message backstop were removed outright (no repetition,
  // cycle, or no-progress detection on the main director loop, matching the
  // baseline of both peer coding agents). Identical tool calls, repeatedly,
  // no longer stop the session — a transport-level abort or an explicit
  // operator interrupt are the only ways it stops.
  test("identical tool calls repeated many times no longer auto-pause the session", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    const actions = await runToolOnlyStreak(director, capabilities, 60, repeatedToolOnlyTurn);
    expect(actions.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(
      false,
    );
    expect(actions.some((a) => a.type === "infer")).toBe(true);
  });
});

// CL-6910: the harness's own retry policy (vendor/intx-inference/src/
// retry-policy.ts) already owns `timeout`/`retryable`/`quota_exhausted` and
// exhausts its full attempt budget (3 attempts) before an `inference.error`
// of one of those categories ever reaches the director. The director must
// not re-wrap those categories in another `capabilities.infer()` call — that
// multiplied the two layers' attempt budgets (up to 9 identical full-context
// sends per turn) instead of composing them. `aborted` (internal-recovery)
// is the one category the harness never retries at all, so it remains the
// director's to recover, and that recovery does not compound with harness
// attempts.
function inferenceErrorEvent(
  category: "retryable" | "timeout" | "aborted" | "quota_exhausted",
  raw?: unknown,
): ReactorInboundEvent {
  return {
    type: "inference.error",
    error: { category, message: "boom", raw },
  } as unknown as ReactorInboundEvent;
}

describe("ChatDirector inference-error recovery (CL-6910)", () => {
  const providerlessPolicy = { providerName: "test-provider" };

  test.each(["retryable", "timeout", "quota_exhausted"] as const)(
    "does not re-issue inference for a %s error already exhausted by the harness",
    async (category) => {
      const director = createChatDirector("system", [], {
        onTasksChange: () => {},
        provider: providerlessPolicy,
      });
      const capabilities = makeCapabilities();

      const actions = actionsArray(
        await director.decide(inferenceErrorEvent(category), mockState, capabilities),
      );

      // No additional full-context send: the base director's terminal
      // checkpoint + reply is the only outcome, not another `infer`.
      expect(actions.some((a) => a.type === "infer")).toBe(false);
      expect(actions.some((a) => a.type === "reply")).toBe(true);
    },
  );

  test("still recovers on internal-recovery abort, bounded by MAX_INFERENCE_RECOVERIES", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();
    const internalAbort = inferenceErrorEvent("aborted", { origin: "internal-recovery" });

    // Recovery 1 of 2: re-issues inference.
    const first = actionsArray(await director.decide(internalAbort, mockState, capabilities));
    expect(first.some((a) => a.type === "infer")).toBe(true);

    // Recovery 2 of 2: re-issues inference.
    const second = actionsArray(await director.decide(internalAbort, mockState, capabilities));
    expect(second.some((a) => a.type === "infer")).toBe(true);

    // Budget exhausted: no further infer, terminal reply instead.
    const third = actionsArray(await director.decide(internalAbort, mockState, capabilities));
    expect(third.some((a) => a.type === "infer")).toBe(false);
    expect(third.some((a) => a.type === "reply")).toBe(true);
  });

  test("an unrelated aborted error (not internal-recovery) is not recovered by the director", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    const actions = actionsArray(
      await director.decide(
        inferenceErrorEvent("aborted", { origin: "user-stop" }),
        mockState,
        capabilities,
      ),
    );
    expect(actions.some((a) => a.type === "infer")).toBe(false);
  });

  test("inference-recovery budget resets at the next turn boundary", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();
    const internalAbort = inferenceErrorEvent("aborted", { origin: "internal-recovery" });

    await director.decide(internalAbort, mockState, capabilities);
    await director.decide(internalAbort, mockState, capabilities);
    // Budget exhausted for this turn.
    const exhausted = actionsArray(await director.decide(internalAbort, mockState, capabilities));
    expect(exhausted.some((a) => a.type === "infer")).toBe(false);

    // A fresh turn boundary (inference.done) resets the budget.
    await director.decide(toolOnlyTurn("post-boundary"), mockState, capabilities);
    const afterBoundary = actionsArray(
      await director.decide(internalAbort, mockState, capabilities),
    );
    expect(afterBoundary.some((a) => a.type === "infer")).toBe(true);
  });

  // Bounds the worst-case number of on-wire full-context sends per logical
  // turn across the two layers that can legitimately fire: the harness's
  // own retry policy (up to 3 attempts per `infer()` call — see
  // vendor/intx-inference/src/retry-policy.ts MAX_ATTEMPTS) and the
  // director's internal-recovery-only budget (up to 2 extra `infer()`
  // calls). Before this fix, `retryable`/`timeout` re-entered this same
  // director budget on top of the harness's exhausted 3, multiplying to 9.
  // After this fix, `retryable`/`timeout`/`quota_exhausted` are harness-only
  // (bounded at 3, asserted against createDefaultRetryPolicy behavior in
  // retry-policy.test.ts), and `aborted` is director-only: each of the
  // director's up-to-3 infer() calls (1 initial + 2 recoveries) is a single
  // harness attempt because the harness's own policy never retries
  // `aborted`. Worst case across a turn that alternates categories is
  // bounded, not open-ended, and never reaches 9.
  test("worst case: director-owned recovery path issues at most 1 + MAX_INFERENCE_RECOVERIES infer calls", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();
    const internalAbort = inferenceErrorEvent("aborted", { origin: "internal-recovery" });

    let inferCount = 0;
    for (let i = 0; i < 10; i++) {
      const actions = actionsArray(await director.decide(internalAbort, mockState, capabilities));
      if (actions.some((a) => a.type === "infer")) inferCount++;
      else break;
    }
    expect(inferCount).toBe(2); // MAX_INFERENCE_RECOVERIES
  });

  test("timeout category produces the timeout preamble, not the fatal fallback", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    const actions = actionsArray(
      await director.decide(inferenceErrorEvent("timeout"), mockState, capabilities),
    );
    const reply = actions.find((a) => a.type === "reply");
    expect(reply).toBeDefined();
    expect((reply as { content: string }).content).toContain("did not respond in time");
    expect((reply as { content: string }).content).not.toContain("unrecoverable inference error");
  });
});
