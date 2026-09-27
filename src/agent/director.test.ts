import { describe, expect, test } from "bun:test";
import type {
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
  ReactorState,
} from "@intx/types/runtime";
import {
  CHAT_TASKS_CHANGED_EVENT,
  createChatDirector,
  toolSetDigest,
} from "./director.js";
import type { WorkflowCoordinator } from "../workflows/coordinator.js";

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

describe("ChatDirector credential recovery continuation", () => {
  const continuation = (generation: number): ReactorInboundEvent =>
    ({
      type: "message.received",
      message: {
        ref: { uid: 0, mailbox: "system" },
        headers: {
          from: "user@local",
          to: ["agent@local"],
          date: "2026-09-26T00:00:00.000Z",
          messageId: `credential-recovery-${generation}@local`,
          interchangeType: "system.credential.refresh",
          interchangeCorrelationId: String(generation),
        },
        flags: [],
        content: "",
        signatureStatus: "missing",
      },
    }) as ReactorInboundEvent;

  test("consumes one matching armed continuation and rejects stale or repeated delivery", async () => {
    const director = createChatDirector("system", [], {});
    const capabilities = makeCapabilities();

    expect(
      actionsArray(
        await director.decide(continuation(4), mockState, capabilities),
      ),
    ).toEqual([{ type: "reply", content: "" }]);

    director.armCredentialRecoveryContinuation(5);
    expect(
      actionsArray(
        await director.decide(continuation(4), mockState, capabilities),
      ),
    ).toEqual([{ type: "reply", content: "" }]);
    expect(
      actionsArray(
        await director.decide(continuation(5), mockState, capabilities),
      ).map((action) => action.type),
    ).toEqual(["infer"]);
    expect(
      actionsArray(
        await director.decide(continuation(5), mockState, capabilities),
      ),
    ).toEqual([{ type: "reply", content: "" }]);
  });
});

describe("ChatDirector tool-only loop protection", () => {
  const providerlessPolicy = { providerName: "test-provider" };

  test("nudges once at the family threshold, after pending tools execute", async () => {
    const director = createChatDirector("system", [], {
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

  // A turn that throws after queueing task-change notifications must drop the
  // queue instead of flushing it stale on the next turn.
  test("a throwing turn drops queued task-change notifications", async () => {
    const throwingCoordinator = {
      isActive: () => true,
      currentStepIsGate: () => true,
      currentStepId: () => null,
      directive: () => {
        throw new Error("tool-listing exploded");
      },
      handleToolDone: () => false,
    } as unknown as WorkflowCoordinator;
    const director = createChatDirector("system", [], {});
    director.setWorkflowCoordinator(throwingCoordinator);
    const capabilities = makeCapabilities();

    const manageTasksTurn = {
      type: "inference.done",
      turn: {
        role: "assistant",
        model: "test",
        timestamp: 0,
        content: [
          {
            type: "tool_call",
            id: "manage-tasks",
            name: "manage_tasks",
            arguments: {
              action: "create",
              tasks: [{ id: "t1", title: "work", status: "doing" }],
            },
          },
        ],
      },
      usage: { input: 0, output: 0 },
      source: "test",
    } as unknown as ReactorInboundEvent;

    await expect(
      director.decide(manageTasksTurn, mockState, capabilities),
    ).rejects.toThrow("tool-listing exploded");

    director.setWorkflowCoordinator(undefined);
    const textTurn = {
      type: "inference.done",
      turn: {
        role: "assistant",
        model: "test",
        timestamp: 0,
        content: [{ type: "text", text: "all set" }],
      },
      usage: { input: 0, output: 0 },
      source: "test",
    } as unknown as ReactorInboundEvent;
    const actions = actionsArray(
      await director.decide(textTurn, mockState, capabilities),
    );
    const stale = actions.filter(
      (a) =>
        a.type === "emit" &&
        (a as { eventType?: string }).eventType === CHAT_TASKS_CHANGED_EVENT,
    );
    expect(stale).toEqual([]);
  });

  function keeperManageTasksTurn(): ReactorInboundEvent {
    return {
      type: "inference.done",
      turn: {
        role: "assistant",
        model: "test",
        timestamp: 0,
        content: [
          {
            type: "tool_call",
            id: "manage-tasks",
            name: "manage_tasks",
            arguments: {
              action: "create",
              tasks: [{ id: "t1", title: "work", status: "doing" }],
            },
          },
        ],
      },
      usage: { input: 0, output: 0 },
      source: "test",
    } as unknown as ReactorInboundEvent;
  }

  function keeperManageTasksPlusSubmitTurn(): ReactorInboundEvent {
    return {
      type: "inference.done",
      turn: {
        role: "assistant",
        model: "test",
        timestamp: 0,
        content: [
          {
            type: "tool_call",
            id: "manage-tasks",
            name: "manage_tasks",
            arguments: {
              action: "create",
              tasks: [{ id: "t1", title: "work", status: "doing" }],
            },
          },
          {
            type: "tool_call",
            id: "submit-1",
            name: "submit_output",
            arguments: { step: "step-1" },
          },
        ],
      },
      usage: { input: 0, output: 0 },
      source: "test",
    } as unknown as ReactorInboundEvent;
  }

  function keeperTextTurn(): ReactorInboundEvent {
    return {
      type: "inference.done",
      turn: {
        role: "assistant",
        model: "test",
        timestamp: 0,
        content: [{ type: "text", text: "all set" }],
      },
      usage: { input: 0, output: 0 },
      source: "test",
    } as unknown as ReactorInboundEvent;
  }

  function keeperTasksChanged(actions: ReactorAction[]): ReactorAction[] {
    return actions.filter(
      (a) =>
        a.type === "emit" &&
        (a as { eventType?: string }).eventType === CHAT_TASKS_CHANGED_EVENT,
    );
  }

  // CL-7992 K1: every coordinator rail consulted on the turn boundary
  // rethrows instead of degrading — a throwing rail rejects decide() and
  // the next turn carries no stale task-change notifications.
  test.each(["isActive", "currentStepIsGate", "currentStepId"] as const)(
    "a throwing %s rail rejects the inference turn without leaking task-change emits",
    async (rail) => {
      const failure = new Error(`${rail} exploded`);
      const coordinator = {
        isActive: () => {
          if (rail === "isActive") throw failure;
          return true;
        },
        currentStepIsGate: () => {
          if (rail === "currentStepIsGate") throw failure;
          return false;
        },
        currentStepId: () => {
          if (rail === "currentStepId") throw failure;
          return null;
        },
        directive: () => null,
        handleToolDone: () => false,
      } as unknown as WorkflowCoordinator;
      const director = createChatDirector("system", [], {});
      director.setWorkflowCoordinator(coordinator);
      const capabilities = makeCapabilities();

      // The step-id rail only runs past a terminal base action, so it
      // throws on a text turn; the earlier rails throw on a manage_tasks
      // turn after it queues its task-change notification.
      const triggering =
        rail === "currentStepId" ? keeperTextTurn() : keeperManageTasksTurn();
      await expect(
        director.decide(triggering, mockState, capabilities),
      ).rejects.toBe(failure);

      director.setWorkflowCoordinator(undefined);
      const actions = actionsArray(
        await director.decide(keeperTextTurn(), mockState, capabilities),
      );
      expect(keeperTasksChanged(actions)).toEqual([]);
    },
  );

  // CL-7992 K2: a mid-turn failure outside the coordinator still rejects
  // the turn, but already-queued notifications survive for the next turn.
  test("a non-coordinator mid-turn failure preserves queued task-change emits for the next turn", async () => {
    const failure = new Error("tool execution exploded");
    const director = createChatDirector("system", [], {});
    const capabilities = makeCapabilities();
    const executing: ReactorCapabilities = {
      ...capabilities,
      executeTools: (): ReactorAction => {
        throw failure;
      },
    };

    await expect(
      director.decide(keeperManageTasksTurn(), mockState, executing),
    ).rejects.toBe(failure);

    const actions = actionsArray(
      await director.decide(keeperTextTurn(), mockState, capabilities),
    );
    expect(keeperTasksChanged(actions)).toHaveLength(1);
  });

  // CL-7992 K2 variant: a throwing handleToolDone degrades (it takes no
  // rethrow parameter) instead of marking the turn stale, so a later
  // non-coordinator failure still preserves the queued notifications.
  test("a throwing handleToolDone degrades without dropping preserved task-change emits", async () => {
    let handleToolDoneSeen = false;
    const coordinator = {
      isActive: () => false,
      currentStepIsGate: () => false,
      currentStepId: () => null,
      directive: () => null,
      handleToolDone: (): boolean => {
        handleToolDoneSeen = true;
        throw new Error("coordinator completion exploded");
      },
    } as unknown as WorkflowCoordinator;
    const director = createChatDirector("system", [], {});
    director.setWorkflowCoordinator(coordinator);
    const capabilities = makeCapabilities();
    const executing: ReactorCapabilities = {
      ...capabilities,
      executeTools: (): ReactorAction => {
        throw new Error("tool execution exploded");
      },
    };

    await expect(
      director.decide(keeperManageTasksPlusSubmitTurn(), mockState, executing),
    ).rejects.toThrow("tool execution exploded");

    const brokenState = {
      get turns(): never {
        throw new Error("history unavailable");
      },
    } as unknown as ReactorState;
    await expect(
      director.decide(toolDoneEvent("submit-1"), brokenState, capabilities),
    ).rejects.toThrow("history unavailable");
    expect(handleToolDoneSeen).toBe(true);

    director.setWorkflowCoordinator(undefined);
    const actions = actionsArray(
      await director.decide(keeperTextTurn(), mockState, capabilities),
    );
    expect(keeperTasksChanged(actions)).toHaveLength(1);
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
