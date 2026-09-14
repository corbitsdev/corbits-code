import { describe, expect, test } from "bun:test";
import type {
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
  ReactorState,
} from "@intx/types/runtime";
import { createChatDirector, toolSetDigest } from "./director.js";

const mockState: ReactorState = { turns: [] } as unknown as ReactorState;

function makeCapabilities(): ReactorCapabilities {
  return {
    infer: (options) =>
      ({
        type: "infer",
        ...(options !== undefined ? { options } : {}),
      }) as ReactorAction,
    executeTools: (calls, parallel, addToHistory) =>
      ({
        type: "execute_tools",
        calls,
        parallel,
        addToHistory,
      }) as ReactorAction,
    suspend: (gate) => ({ type: "suspend", gate }) as ReactorAction,
    fork: (mode, forkId) => ({ type: "fork", mode, forkId }) as ReactorAction,
    emit: (eventType, data) =>
      ({ type: "emit", eventType, data }) as ReactorAction,
    reply: (content) => ({ type: "reply", content }) as ReactorAction,
    checkpoint: (message = "") =>
      ({ type: "checkpoint", message }) as ReactorAction,
    compact: (compactor, reason) =>
      ({ type: "compact", compactor, reason }) as ReactorAction,
    wait: () => ({ type: "wait" }) as ReactorAction,
    done: () => ({ type: "done" }) as ReactorAction,
  };
}

// Varied arguments per call so the fingerprint changes turn to turn — the
// shape of genuine, varied tool-only orchestration (Linear lookups, reading
// different files, ...).
function toolOnlyTurn(id: string): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      model: "test",
      timestamp: 0,
      content: [
        {
          type: "tool_call",
          id,
          name: "read_file",
          arguments: { path: `${id}.ts` },
        },
      ],
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

function actionsArray(
  result: ReactorAction | ReactorAction[],
): ReactorAction[] {
  return Array.isArray(result) ? result : [result];
}

function ephemeralText(action: ReactorAction | undefined): string | undefined {
  if (action === undefined || action.type !== "infer") return undefined;
  const opts = action.options as
    | { ephemeralTurns?: { content: { text?: string }[] }[] }
    | undefined;
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
    last = actionsArray(
      await director.decide(toolDoneEvent(id), mockState, capabilities),
    );
  }
  return last;
}

describe("toolSetDigest", () => {
  const base = {
    name: "read_file",
    description: "read a file",
    inputSchema: { type: "object" },
  };

  test("identical sets share a digest", () => {
    expect(toolSetDigest([{ ...base }])).toBe(toolSetDigest([{ ...base }]));
  });

  // The digest gates the tool-set-changed log line, and the serialized tools
  // array is the head of the provider's cached prompt prefix — an
  // inputSchema-only change reshapes the wire bytes, so it must move the
  // digest or the cache bust goes unlogged.
  test("an inputSchema-only change alters the digest", () => {
    const before = [{ ...base }];
    const after = [
      {
        ...base,
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ];
    expect(toolSetDigest(after)).not.toBe(toolSetDigest(before));
  });
});

describe("ChatDirector tool-only loop protection", () => {
  const providerlessPolicy = { providerName: "test-provider" };

  test("nudges once at the family threshold, after pending tools execute", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => undefined,
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
      onTasksChange: () => undefined,
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    await runToolOnlyStreak(director, capabilities, 25);
    const nextTurn = actionsArray(
      await runToolOnlyStreak(director, capabilities, 1),
    );
    const infer = nextTurn.find((a) => a.type === "infer");
    expect(infer).toBeDefined();
    expect(ephemeralText(infer)).toBeUndefined();
  });

  // Required by CL-5611: a long productive tool-only streak (varied
  // fingerprints every turn) must run straight through both the nudge and
  // well past any prior hard-pause threshold without ever pausing.
  test("a long productive tool-only streak continues without pausing", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => undefined,
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    const actions = await runToolOnlyStreak(director, capabilities, 50);
    expect(
      actions.some(
        (a) => a.type === "reply" && a.content.includes("Auto-paused"),
      ),
    ).toBe(false);
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
        onTasksChange: () => undefined,
        provider: providerlessPolicy,
      });
      const capabilities = makeCapabilities();

      const actions = actionsArray(
        await director.decide(
          inferenceErrorEvent(category),
          mockState,
          capabilities,
        ),
      );

      // No additional full-context send: the base director's terminal
      // checkpoint + reply is the only outcome, not another `infer`.
      expect(actions.some((a) => a.type === "infer")).toBe(false);
      expect(actions.some((a) => a.type === "reply")).toBe(true);
    },
  );

  test("still recovers on internal-recovery abort, bounded by MAX_INFERENCE_RECOVERIES", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => undefined,
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();
    const internalAbort = inferenceErrorEvent("aborted", {
      origin: "internal-recovery",
    });

    // Recovery 1 of 2: re-issues inference.
    const first = actionsArray(
      await director.decide(internalAbort, mockState, capabilities),
    );
    expect(first.some((a) => a.type === "infer")).toBe(true);

    // Recovery 2 of 2: re-issues inference.
    const second = actionsArray(
      await director.decide(internalAbort, mockState, capabilities),
    );
    expect(second.some((a) => a.type === "infer")).toBe(true);

    // Budget exhausted: no further infer, terminal reply instead.
    const third = actionsArray(
      await director.decide(internalAbort, mockState, capabilities),
    );
    expect(third.some((a) => a.type === "infer")).toBe(false);
    expect(third.some((a) => a.type === "reply")).toBe(true);
  });

  test("an unrelated aborted error (not internal-recovery) is not recovered by the director", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => undefined,
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
      onTasksChange: () => undefined,
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();
    const internalAbort = inferenceErrorEvent("aborted", {
      origin: "internal-recovery",
    });

    await director.decide(internalAbort, mockState, capabilities);
    await director.decide(internalAbort, mockState, capabilities);
    // Budget exhausted for this turn.
    const exhausted = actionsArray(
      await director.decide(internalAbort, mockState, capabilities),
    );
    expect(exhausted.some((a) => a.type === "infer")).toBe(false);

    // A fresh turn boundary (inference.done) resets the budget.
    await director.decide(
      toolOnlyTurn("post-boundary"),
      mockState,
      capabilities,
    );
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
      onTasksChange: () => undefined,
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();
    const internalAbort = inferenceErrorEvent("aborted", {
      origin: "internal-recovery",
    });

    let inferCount = 0;
    for (let i = 0; i < 10; i++) {
      const actions = actionsArray(
        await director.decide(internalAbort, mockState, capabilities),
      );
      if (actions.some((a) => a.type === "infer")) inferCount++;
      else break;
    }
    expect(inferCount).toBe(2); // MAX_INFERENCE_RECOVERIES
  });

  test("timeout category produces the timeout preamble, not the fatal fallback", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => undefined,
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    const actions = actionsArray(
      await director.decide(
        inferenceErrorEvent("timeout"),
        mockState,
        capabilities,
      ),
    );
    const reply = actions.find((a) => a.type === "reply");
    expect(reply).toBeDefined();
    expect((reply as { content: string }).content).toContain(
      "did not respond in time",
    );
    expect((reply as { content: string }).content).not.toContain(
      "unrecoverable inference error",
    );
  });
});

// CL-7973: the director's live source id (which stamps retry decisions so a
// mid-session /model switch remaps the xAI short-429 handling) is observable
// only through the retry policy it hands to each infer action. An xAI-gated
// capacity error retries when the tracked id is an xAI source and aborts
// otherwise, so driving tracking events then invoking the attached policy
// reads the tracked id without reaching into privates.
type LiveRetryPolicy = (situation: {
  attempt: number;
  elapsedMs: number;
  error: { category: "protocol_mismatch"; message: string };
}) => Promise<{ kind: string }> | { kind: string };

function textCompletion(sourceId?: string): ReactorInboundEvent {
  const turn = {
    role: "assistant",
    model: "test",
    timestamp: 0,
    content: [{ type: "text", text: "done work" }],
  };
  const event: Record<string, unknown> = {
    type: "inference.done",
    turn,
    usage: { input: 0, output: 0 },
  };
  if (sourceId !== undefined)
    event["source"] = { sourceId, provider: "p", model: "test" };
  return event as unknown as ReactorInboundEvent;
}

function stateWithCycleSource(sourceId: string): ReactorState {
  return {
    turns: [],
    lastCycleSource: { sourceId, provider: "p", model: "test" },
  } as unknown as ReactorState;
}

async function liveRetryPolicy(
  director: ReturnType<typeof createChatDirector>,
  capabilities: ReactorCapabilities,
): Promise<LiveRetryPolicy> {
  await director.decide(toolOnlyTurn("source-probe"), mockState, capabilities);
  const actions = actionsArray(
    await director.decide(
      toolDoneEvent("source-probe"),
      mockState,
      capabilities,
    ),
  );
  const infer = actions.find((a) => a.type === "infer") as
    | { type: "infer"; options?: { retryPolicy?: LiveRetryPolicy } }
    | undefined;
  if (infer?.options?.retryPolicy === undefined)
    throw new Error("expected an infer action carrying the live retry policy");
  return infer.options.retryPolicy;
}

async function isXaiStamped(policy: LiveRetryPolicy): Promise<boolean> {
  const decision = await policy({
    attempt: 1,
    elapsedMs: 0,
    error: {
      category: "protocol_mismatch",
      message: "The model is currently at capacity",
    },
  });
  return decision.kind === "retry";
}

describe("ChatDirector live source-id tracking (CL-7973)", () => {
  test("a sourceless or empty-string completion never wipes the learned id", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => undefined,
      provider: { providerName: "test-provider" },
    });
    const capabilities = makeCapabilities();
    const policy = await liveRetryPolicy(director, capabilities);

    // The seed id is not an xAI source, so the capacity error aborts.
    expect(await isXaiStamped(policy)).toBe(false);

    // A completion stamps the source that served it.
    await director.decide(
      textCompletion("xai/learned"),
      mockState,
      capabilities,
    );
    expect(await isXaiStamped(policy)).toBe(true);

    // A completion carrying no source keeps the learned id.
    await director.decide(textCompletion(), mockState, capabilities);
    expect(await isXaiStamped(policy)).toBe(true);

    // An empty-string source id never clobbers the learned id.
    await director.decide(textCompletion(""), mockState, capabilities);
    expect(await isXaiStamped(policy)).toBe(true);

    // An empty-string cycle source never clobbers it either.
    await director.decide(
      toolDoneEvent("empty-cycle"),
      stateWithCycleSource(""),
      capabilities,
    );
    expect(await isXaiStamped(policy)).toBe(true);
  });

  test("a cycle source remaps tracking on a non-inference event", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => undefined,
      provider: { providerName: "test-provider" },
    });
    const capabilities = makeCapabilities();
    const policy = await liveRetryPolicy(director, capabilities);
    expect(await isXaiStamped(policy)).toBe(false);

    // tool.done carries no source of its own; the harness's cycle source
    // covers the turn and remaps tracking from it.
    await director.decide(
      toolDoneEvent("cycle-remap"),
      stateWithCycleSource("xai/cycle"),
      capabilities,
    );
    expect(await isXaiStamped(policy)).toBe(true);
  });

  test("a drained fleet capitulates to the terminal action after the nudge budget", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => undefined,
      provider: { providerName: "test-provider" },
    });
    director.restoreTasks([{ id: "t1", title: "keep going", status: "todo" }]);
    const capabilities = makeCapabilities();

    // Without the idle-with-fleet allowance (drained fleet), a terminal base
    // action with open tasks re-infers with the open-task nudge a bounded
    // number of times, then lets the terminal action through — the accepted
    // loss stays locked in rather than resuming the nudge.
    for (let i = 0; i < 3; i++) {
      const actions = actionsArray(
        await director.decide(textCompletion(), mockState, capabilities),
      );
      expect(actions.some((a) => a.type === "infer")).toBe(true);
      expect(actions.some((a) => a.type === "reply")).toBe(false);
    }
    const terminal = actionsArray(
      await director.decide(textCompletion(), mockState, capabilities),
    );
    expect(terminal.some((a) => a.type === "infer")).toBe(false);
    expect(terminal.some((a) => a.type === "reply")).toBe(true);
  });

  test("a cycle source wins over a contradictory event source", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => undefined,
      provider: { providerName: "test-provider" },
    });
    const capabilities = makeCapabilities();
    const policy = await liveRetryPolicy(director, capabilities);

    // The harness's call-start snapshot is authoritative over the event's
    // own stamp, so when both are present the cycle source defines tracking.
    await director.decide(
      textCompletion("other/default"),
      stateWithCycleSource("xai/cycle"),
      capabilities,
    );
    expect(await isXaiStamped(policy)).toBe(true);
  });
});
