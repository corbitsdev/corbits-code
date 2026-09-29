import { describe, expect, test } from "bun:test";
import type {
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
  ReactorState,
} from "@intx/types/runtime";
import {
  askOperatorDefinition,
  CHAT_TASKS_CHANGED_EVENT,
  CHAT_TOOLS_ACTIVATE_EVENT,
  createChatDirector,
  toolSetDigest,
} from "./director.js";
import type { WorkflowCoordinator } from "../workflows/coordinator.js";
import {
  COMPACTION_CONTINUATION_EVENT,
  stickyExtraInstructionsFromRecords,
} from "./compaction.js";
import { createAgentToolset } from "./tools.js";
import { createAdvertisedToolset } from "../session/assemble-runtime.js";
import { createPermissionGate } from "../permission/gate.js";
import {
  COMPACTOR_KEEP_RECENT_TURNS,
  COMPACT_SPACER_TEXT,
  LEGACY_COMPACT_SPACER_TEXT,
  compactorNoOpFloor,
} from "../session/compactor.js";
import {
  INFERENCE_ABORT_INTERNAL_RECOVERY,
  INFERENCE_ABORT_USER_STOP,
} from "../inference-abort.js";
import {
  stubReactorCapabilities,
  stubReactorState,
  stubTextTurnEvent,
} from "../testkit/reactor-stubs.js";
import {
  validateActions,
  type ExtendedInferenceOptions,
} from "@intx/inference";

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

  // user-stop origin: the "does not auto-recover user-stop aborted inference
  // errors" test in chatDirector compaction pins this classification (and the
  // absence of the recovery checkpoint) at the long-state layer.
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

function makeInferenceDoneEvent(
  toolCalls: { id: string; name: string; args?: Record<string, unknown> }[],
) {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      model: "test",
      timestamp: 0,
      content: toolCalls.map((tc) => ({
        type: "tool_call",
        id: tc.id,
        name: tc.name,
        arguments: tc.args ?? {},
      })),
    },
    usage: { input: 0, output: 0 },
    source: "test",
  } as unknown as ReactorInboundEvent;
}

function makeToolDoneEvent(callId: string) {
  return {
    type: "tool.done",
    result: { callId, content: "ok" },
  } as unknown as ReactorInboundEvent;
}

function makeToolErrorEvent(callId: string, content: string) {
  return {
    type: "tool.done",
    result: { callId, content, isError: true },
  } as unknown as ReactorInboundEvent;
}

// One turn past createPruningCompactor's own no-op floor (session/compactor.ts),
// so the arming check finds a history actually worth compacting.
const longState = {
  turns: Array.from(
    { length: compactorNoOpFloor(COMPACTOR_KEEP_RECENT_TURNS) + 1 },
    () => ({
      role: "user",
      content: [],
      timestamp: 0,
    }),
  ),
} as unknown as ReactorState;

function messageReceived(content: string): ReactorInboundEvent {
  return {
    type: "message.received",
    message: { role: "user", content },
  } as unknown as ReactorInboundEvent;
}

/** Infer stub that carries the options through so tests can inspect them. */
const capabilitiesWithInferArgs: ReactorCapabilities = {
  ...stubReactorCapabilities,
  infer: (opts) =>
    ({ type: "infer", options: opts }) as unknown as ReactorAction,
};

function manageTasksEvent(
  status: "todo" | "doing" | "done",
): ReactorInboundEvent {
  return makeInferenceDoneEvent([
    {
      id: "m",
      name: "manage_tasks",
      args: {
        action: "create",
        tasks: [{ id: "t1", title: "work", status }],
      },
    },
  ]);
}

const hasInfer = (a: ReactorAction[]): boolean =>
  a.some((x) => x.type === "infer");
const hasReply = (a: ReactorAction[]): boolean =>
  a.some((x) => x.type === "reply");

describe("ask_operator definition", () => {
  test("has no command field", () => {
    const schema = askOperatorDefinition.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties).not.toHaveProperty("command");
  });
});

describe("operator declined tool calls", () => {
  const declined =
    "Blocked by permission policy: Operator declined: Run shell command (npm view hono version)";

  const hasCheckpoint = (actions: ReactorAction[]): boolean =>
    actions.some(
      (a) =>
        a.type === "checkpoint" &&
        "message" in a &&
        a.message === "operator-declined",
    );
  const hasDeclineReply = (actions: ReactorAction[]): boolean =>
    actions.some(
      (a) =>
        a.type === "reply" &&
        "content" in a &&
        a.content === "Tool call rejected by operator.",
    );
  const hasInfer = (actions: ReactorAction[]): boolean =>
    actions.some((a) => a.type === "infer");
  const hasDone = (actions: ReactorAction[]): boolean =>
    actions.some((a) => a.type === "done");

  // Contract: interactive chat surfaces the rejection and waits for
  // the next user message; it does NOT emit done(), which would kill the
  // reactor and break further sends, and it does not re-infer off a bare
  // decline.
  test("chat director surfaces the decline and waits, keeping the reactor alive", async () => {
    const director = createChatDirector("", [], {});
    const actions = actionsArray(
      await director.decide(
        makeToolErrorEvent("c", declined),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(hasCheckpoint(actions)).toBe(true);
    expect(hasDeclineReply(actions)).toBe(true);
    // No done(): the TUI must stay alive so the user can send another message.
    expect(hasDone(actions)).toBe(false);
    expect(hasInfer(actions)).toBe(false);
  });

  // Reactor path: a reason-bearing rejection must re-infer so the model can
  // respond to the reason — never the canned decline, from any origin.
  test.each([
    ["approver", "denied by approver: never touch /etc"],
    ["middleware", `${declined} — only run it in the build sandbox`],
  ])(
    "a reason-bearing %s rejection re-infers on the reason",
    async (_origin, content) => {
      const director = createChatDirector("", [], {});
      const actions = actionsArray(
        await director.decide(
          makeToolErrorEvent("c", content),
          stubReactorState,
          stubReactorCapabilities,
        ),
      );
      expect(hasInfer(actions)).toBe(true);
      expect(hasDeclineReply(actions)).toBe(false);
      expect(hasCheckpoint(actions)).toBe(false);
    },
  );

  // Reactor path: a reason-less approver rejection has nothing for the model
  // to respond to; the canned reply stands.
  test("reason-less approver rejection takes the canned path", async () => {
    const director = createChatDirector("", [], {});
    const actions = actionsArray(
      await director.decide(
        makeToolErrorEvent("c", "denied by approver"),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(hasCheckpoint(actions)).toBe(true);
    expect(hasDeclineReply(actions)).toBe(true);
    expect(hasInfer(actions)).toBe(false);
  });

  // Policy denies and no-grant blocks are not operator decisions: the model
  // adapts to the deny text like any tool error.
  test("policy deny is not classified as an operator decline", async () => {
    const director = createChatDirector("", [], {});
    for (const content of [
      "Denied by policy: tool:run_shell/invoke",
      "No matching grants for tool:run_shell/invoke",
    ]) {
      const actions = actionsArray(
        await director.decide(
          makeToolErrorEvent("c", content),
          stubReactorState,
          stubReactorCapabilities,
        ),
      );
      expect(hasInfer(actions)).toBe(true);
      expect(hasDeclineReply(actions)).toBe(false);
      expect(hasCheckpoint(actions)).toBe(false);
    }
  });
});

describe("open-task termination guard", () => {
  const declined =
    "Blocked by permission policy: Operator declined: Run shell command (rm -rf build)";

  test("decide does not throw when manage_tasks arguments are frozen", async () => {
    const director = createChatDirector("base", [], {});
    const event = manageTasksEvent("todo");
    const freeze = (value: unknown): void => {
      if (value === null || typeof value !== "object" || Object.isFrozen(value))
        return;
      for (const key of Object.getOwnPropertyNames(value)) {
        freeze((value as Record<string, unknown>)[key]);
      }
      Object.freeze(value);
    };
    freeze(event);
    await expect(
      director.decide(event, stubReactorState, stubReactorCapabilities),
    ).resolves.toBeDefined();
  });

  test("re-infers instead of ending the turn while a task is still open", async () => {
    const director = createChatDirector("base", [], {});
    await director.decide(
      manageTasksEvent("doing"),
      stubReactorState,
      stubReactorCapabilities,
    );

    const actions = actionsArray(
      await director.decide(
        stubTextTurnEvent(),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(hasInfer(actions)).toBe(true);
    expect(hasReply(actions)).toBe(false);
  });

  test("ends the turn normally once every task is terminal", async () => {
    const director = createChatDirector("base", [], {});
    await director.decide(
      manageTasksEvent("done"),
      stubReactorState,
      stubReactorCapabilities,
    );

    const actions = actionsArray(
      await director.decide(
        stubTextTurnEvent(),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(hasReply(actions)).toBe(true);
    expect(hasInfer(actions)).toBe(false);
  });

  test("a task change emits the updated task list on the chat event", async () => {
    const director = createChatDirector("base", [], {});
    const actions = actionsArray(
      await director.decide(
        manageTasksEvent("doing"),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(
      actions.filter(
        (a) =>
          a.type === "emit" &&
          (a as { eventType?: string }).eventType === CHAT_TASKS_CHANGED_EVENT,
      ),
    ).toEqual([
      {
        type: "emit",
        eventType: CHAT_TASKS_CHANGED_EVENT,
        data: { tasks: [{ id: "t1", title: "work", status: "doing" }] },
      },
    ]);
  });

  test("stops nudging and lets the turn end after the cap of content-free attempts", async () => {
    const director = createChatDirector("base", [], {});
    await director.decide(
      manageTasksEvent("doing"),
      stubReactorState,
      stubReactorCapabilities,
    );

    for (let i = 0; i < 3; i++) {
      const nudged = actionsArray(
        await director.decide(
          stubTextTurnEvent(),
          stubReactorState,
          stubReactorCapabilities,
        ),
      );
      expect(hasInfer(nudged)).toBe(true);
    }
    const exhausted = actionsArray(
      await director.decide(
        stubTextTurnEvent(),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(hasReply(exhausted)).toBe(true);
    expect(hasInfer(exhausted)).toBe(false);
  });

  test("idle-with-fleet allows terminal wait/reply with open tasks and spends no nudge budget", async () => {
    const director = createChatDirector("base", [], {
      allowIdleWithFleet: true,
    });
    await director.decide(
      manageTasksEvent("doing"),
      stubReactorState,
      stubReactorCapabilities,
    );

    for (let i = 0; i < 4; i++) {
      const actions = actionsArray(
        await director.decide(
          stubTextTurnEvent(),
          stubReactorState,
          stubReactorCapabilities,
        ),
      );
      expect(hasInfer(actions)).toBe(false);
      expect(hasReply(actions)).toBe(true);
    }
  });

  test("mid-session source switch remaps retry stamping without host closures", async () => {
    const director = createChatDirector("base", [], {
      provider: { providerName: "openai" },
    });
    await director.decide(
      manageTasksEvent("doing"),
      stubReactorState,
      stubReactorCapabilities,
    );
    const inferPolicyOf = (actions: ReactorAction[]) => {
      const infer = actions.find((a) => a.type === "infer");
      if (infer?.type !== "infer" || infer.options?.retryPolicy === undefined) {
        throw new Error("expected an infer action carrying a retry policy");
      }
      return infer.options.retryPolicy;
    };
    const bare429 = {
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted" as const,
        message: "Too Many Requests",
        statusCode: 429,
        retryAfterMs: 45_000,
        raw: { error: { message: "Too Many Requests" } },
      },
    };

    // Seeded from the session provider: bare 429s abort.
    const before = actionsArray(
      await director.decide(
        stubTextTurnEvent(),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(await inferPolicyOf(before)(bare429)).toEqual({ kind: "abort" });

    // Mid-session /model switch: the next completion stamps the new source,
    // so retry stamping remaps without rebuilding the agent.
    await director.decide(
      {
        type: "inference.done",
        turn: {
          role: "assistant",
          model: "grok",
          timestamp: 0,
          content: [{ type: "text", text: "all set" }],
        },
        usage: {
          input: 10,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          thinking: 0,
        },
        source: {
          sourceId: "xai/thegreataxios",
          provider: "xai",
          model: "grok-4",
        },
      } as unknown as ReactorInboundEvent,
      stubReactorState,
      stubReactorCapabilities,
    );
    const after = actionsArray(
      await director.decide(
        stubTextTurnEvent(),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(await inferPolicyOf(after)(bare429)).toEqual({
      kind: "retry",
      delayMs: 45_000,
    });
  });

  test("setAllowIdleWithFleet tracks fleet transitions off the seeded value", async () => {
    const director = createChatDirector("base", [], {
      allowIdleWithFleet: true,
    });
    await director.decide(
      manageTasksEvent("doing"),
      stubReactorState,
      stubReactorCapabilities,
    );

    // Seeded allowance: terminal reply with open tasks, no nudge spent.
    const seeded = actionsArray(
      await director.decide(
        stubTextTurnEvent(),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(hasReply(seeded)).toBe(true);
    expect(hasInfer(seeded)).toBe(false);

    // Drained fleet resumes the open-task nudge.
    director.setAllowIdleWithFleet(false);
    const nudged = actionsArray(
      await director.decide(
        stubTextTurnEvent(),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(hasInfer(nudged)).toBe(true);
    expect(hasReply(nudged)).toBe(false);

    // Fleet back: terminal allowed again.
    director.setAllowIdleWithFleet(true);
    const settled = actionsArray(
      await director.decide(
        stubTextTurnEvent(),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(hasReply(settled)).toBe(true);
    expect(hasInfer(settled)).toBe(false);
  });

  test("empty model turn settles with a valid empty reply", async () => {
    // DefaultDirector ends empty responses with bare wait; without a reply,
    // agent.send hangs and the TUI Working spinner sticks forever.
    const director = createChatDirector("base", [], {});
    const emptyTurn = {
      type: "inference.done",
      turn: { role: "assistant", model: "test", timestamp: 0, content: [] },
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { model: "test-model" },
    } as unknown as ReactorInboundEvent;

    const actions = actionsArray(
      await director.decide(
        emptyTurn,
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(actions.map((action) => action.type)).toEqual([
      "checkpoint",
      "reply",
    ]);
    expect(
      actions.some(
        (a) => a.type === "reply" && "content" in a && a.content === "",
      ),
    ).toBe(true);
    expect(actions.some((a) => a.type === "wait" || a.type === "infer")).toBe(
      false,
    );
    expect(validateActions(actions).ok).toBe(true);
  });

  test("a declined tool with open tasks re-infers, then terminates after its cap", async () => {
    const director = createChatDirector("base", [], {});
    await director.decide(
      manageTasksEvent("doing"),
      stubReactorState,
      stubReactorCapabilities,
    );

    for (let i = 0; i < 2; i++) {
      const nudged = actionsArray(
        await director.decide(
          makeToolErrorEvent("c", declined),
          stubReactorState,
          stubReactorCapabilities,
        ),
      );
      expect(nudged.some((a) => a.type === "infer")).toBe(true);
      expect(nudged.some((a) => a.type === "reply")).toBe(false);
    }
    const ended = actionsArray(
      await director.decide(
        makeToolErrorEvent("c", declined),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(
      ended.some(
        (a) =>
          a.type === "reply" &&
          "content" in a &&
          a.content === "Tool call rejected by operator.",
      ),
    ).toBe(true);
    expect(ended.some((a) => a.type === "infer")).toBe(false);
  });

  // The budget used to reset on any tool call, which taught weak
  // models that no-op shell narration (e.g. `echo`) resets the clock. A model
  // that only echoes between nudges must still converge to the cap within a
  // single user turn — the budget is monotonic per inbound message, not per
  // tool call, so it does not matter whether a tool call happens at all.
  test("a no-op tool call between nudges does not reset the idle budget", async () => {
    const director = createChatDirector("base", [], {});
    await director.decide(
      manageTasksEvent("doing"),
      stubReactorState,
      stubReactorCapabilities,
    );

    // Two content-free terminations spend two of the three nudges.
    expect(
      hasInfer(
        actionsArray(
          await director.decide(
            stubTextTurnEvent(),
            stubReactorState,
            stubReactorCapabilities,
          ),
        ),
      ),
    ).toBe(true);
    expect(
      hasInfer(
        actionsArray(
          await director.decide(
            stubTextTurnEvent(),
            stubReactorState,
            stubReactorCapabilities,
          ),
        ),
      ),
    ).toBe(true);

    // A no-op shell call (echo) is not a new user turn, so it must not buy
    // back budget.
    await director.decide(
      makeInferenceDoneEvent([
        { id: "e", name: "run_shell", args: { command: "echo done" } },
      ]),
      stubReactorState,
      stubReactorCapabilities,
    );

    // Only one nudge remains from the original budget of three.
    const nudged = actionsArray(
      await director.decide(
        stubTextTurnEvent(),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(hasInfer(nudged)).toBe(true);
    const ended = actionsArray(
      await director.decide(
        stubTextTurnEvent(),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(hasReply(ended)).toBe(true);
    expect(hasInfer(ended)).toBe(false);
  });

  test("a new user message resets the idle budget for the next turn", async () => {
    const director = createChatDirector("base", [], {});
    await director.decide(
      manageTasksEvent("doing"),
      stubReactorState,
      stubReactorCapabilities,
    );

    for (let i = 0; i < 3; i++) {
      expect(
        hasInfer(
          actionsArray(
            await director.decide(
              stubTextTurnEvent(),
              stubReactorState,
              stubReactorCapabilities,
            ),
          ),
        ),
      ).toBe(true);
    }
    const exhausted = actionsArray(
      await director.decide(
        stubTextTurnEvent(),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(hasReply(exhausted)).toBe(true);

    // A fresh inbound user message starts a new turn: the budget is restored.
    await director.decide(
      {
        type: "message.received",
        message: { role: "user", content: "keep going" },
      } as unknown as ReactorInboundEvent,
      stubReactorState,
      stubReactorCapabilities,
    );
    const nudged = actionsArray(
      await director.decide(
        stubTextTurnEvent(),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(hasInfer(nudged)).toBe(true);
  });

  test("a successful tool call between declines does not reset the declined budget", async () => {
    const director = createChatDirector("base", [], {});
    await director.decide(
      manageTasksEvent("doing"),
      stubReactorState,
      stubReactorCapabilities,
    );

    // Spend both of the declined-path nudges, with a successful tool result
    // interleaved after the first. If the successful result reset the budget,
    // a third decline would still re-infer instead of terminating.
    const first = actionsArray(
      await director.decide(
        makeToolErrorEvent("c", declined),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(first.some((a) => a.type === "infer")).toBe(true);

    // A successful (non-error) tool result in between must not buy back budget.
    await director.decide(
      makeToolDoneEvent("ok1"),
      stubReactorState,
      stubReactorCapabilities,
    );

    const second = actionsArray(
      await director.decide(
        makeToolErrorEvent("c", declined),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(second.some((a) => a.type === "infer")).toBe(true);

    const third = actionsArray(
      await director.decide(
        makeToolErrorEvent("c", declined),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(third.some((a) => a.type === "infer")).toBe(false);
    expect(
      third.some(
        (a) =>
          a.type === "reply" &&
          "content" in a &&
          a.content === "Tool call rejected by operator.",
      ),
    ).toBe(true);
  });

  test("a new user turn after a canned decline infers instead of canned-replying", async () => {
    const director = createChatDirector("base", [], {});
    let cleared = 0;
    director.setClearDenials(() => {
      cleared++;
    });
    const declinedTurn = actionsArray(
      await director.decide(
        makeToolErrorEvent("c", declined),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(
      declinedTurn.some(
        (a) =>
          a.type === "reply" &&
          "content" in a &&
          a.content === "Tool call rejected by operator.",
      ),
    ).toBe(true);
    expect(cleared).toBe(0);

    const next = actionsArray(
      await director.decide(
        {
          type: "message.received",
          message: {
            role: "user",
            content: "just talk",
            flags: ["operator-originated"],
          },
        } as unknown as ReactorInboundEvent,
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(
      next.some(
        (a) =>
          a.type === "reply" &&
          "content" in a &&
          a.content === "Tool call rejected by operator.",
      ),
    ).toBe(false);
    expect(next.some((a) => a.type === "infer")).toBe(true);
    expect(cleared).toBe(1);
  });

  test("mailbox inbound does not clear cached denies", async () => {
    const director = createChatDirector("base", [], {});
    let cleared = 0;
    director.setClearDenials(() => {
      cleared++;
    });
    await director.decide(
      makeToolErrorEvent("c", declined),
      stubReactorState,
      stubReactorCapabilities,
    );
    await director.decide(
      {
        type: "message.received",
        message: { role: "user", content: "worker report" },
      } as unknown as ReactorInboundEvent,
      stubReactorState,
      stubReactorCapabilities,
    );
    expect(cleared).toBe(0);
  });
});

describe("chatDirector compaction", () => {
  function textInferenceDone(inputTokens: number): ReactorInboundEvent {
    return {
      type: "inference.done",
      turn: {
        role: "assistant",
        model: "test",
        timestamp: 0,
        content: [{ type: "text", text: "done" }],
      },
      usage: {
        input: inputTokens,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      },
      source: { model: "test-model" },
    } as unknown as ReactorInboundEvent;
  }

  test("schedules idle compaction after an over-threshold text-only reply", async () => {
    const director = createChatDirector("", [], {});
    const replyActions = actionsArray(
      await director.decide(
        textInferenceDone(999_999),
        longState,
        stubReactorCapabilities,
      ),
    );
    expect(replyActions.some((a) => a.type === "reply")).toBe(true);
    expect(replyActions.some((a) => a.type === "compact")).toBe(false);
    // Continuation is expressed as an emit action the host drives.
    expect(
      replyActions.some(
        (a) =>
          a.type === "emit" &&
          "eventType" in a &&
          a.eventType === COMPACTION_CONTINUATION_EVENT,
      ),
    ).toBe(true);

    const compactActions = actionsArray(
      await director.decide(
        messageReceived(""),
        longState,
        stubReactorCapabilities,
      ),
    );
    expect(compactActions).toEqual([
      {
        type: "compact",
        compactor: "pruning-compactor",
        reason: "context-threshold",
      },
      {
        type: "emit",
        eventType: COMPACTION_CONTINUATION_EVENT,
        data: {},
      },
    ]);
  });

  test("idle empty compact makes the post-compact estimate authoritative without inferring", async () => {
    const director = createChatDirector("", [], {});
    const largeTurns = Array.from(
      { length: compactorNoOpFloor(COMPACTOR_KEEP_RECENT_TURNS) + 1 },
      (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: "x".repeat(200) }],
        timestamp: i,
      }),
    );
    const longTurnsState = { turns: largeTurns } as unknown as ReactorState;

    await director.decide(
      textInferenceDone(999_999),
      longTurnsState,
      stubReactorCapabilities,
    );
    expect(director.getContextEstimate().isEstimate).toBe(false);
    const before = director.getContextEstimate().tokens;

    await director.decide(
      messageReceived(""),
      longTurnsState,
      stubReactorCapabilities,
    );

    // Simulate the reactor having compacted, then the meter-sync continuation.
    const shrunkTurns = largeTurns.slice(-3);
    const shrunkState = { turns: shrunkTurns } as unknown as ReactorState;
    const afterActions = actionsArray(
      await director.decide(
        messageReceived(""),
        shrunkState,
        stubReactorCapabilities,
      ),
    );
    expect(afterActions.some((a) => a.type === "infer")).toBe(false);
    expect(
      afterActions.some((a) => a.type === "wait" || a.type === "reply"),
    ).toBe(true);

    const estimate = director.getContextEstimate();
    expect(estimate.isEstimate).toBe(true);
    expect(estimate.tokens).toBeLessThan(before);
  });

  function overThresholdToolTurn(): ReactorInboundEvent {
    return {
      type: "inference.done",
      turn: {
        role: "assistant",
        model: "test",
        timestamp: 0,
        content: [
          {
            type: "tool_call",
            id: "t1",
            name: "read_file",
            arguments: { path: "a.txt" },
          },
        ],
      },
      usage: {
        input: 999_999,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      },
      source: { model: "test-model" },
    } as unknown as ReactorInboundEvent;
  }

  function overflowError(): ReactorInboundEvent {
    return {
      type: "inference.error",
      error: {
        category: "context_overflow",
        message: "context window exceeded",
      },
    } as unknown as ReactorInboundEvent;
  }

  function chatDirector(systemPrompt: string) {
    return createChatDirector(systemPrompt, [], {});
  }

  test("compacts at the tool.done pause once over threshold", async () => {
    const director = chatDirector("Corbits operating prompt");
    await director.decide(
      overThresholdToolTurn(),
      longState,
      stubReactorCapabilities,
    );
    const actions = actionsArray(
      await director.decide(
        makeToolDoneEvent("t1"),
        longState,
        stubReactorCapabilities,
      ),
    );
    expect(
      actions.some(
        (a) =>
          a.type === "compact" &&
          "reason" in a &&
          a.reason === "context-threshold",
      ),
    ).toBe(true);
    expect(actions.some((a) => a.type === "infer")).toBe(false);

    // The continuation message re-enters inference after the compact cycle.
    const resumed = actionsArray(
      await director.decide(
        messageReceived(""),
        longState,
        stubReactorCapabilities,
      ),
    );
    expect(resumed.some((a) => a.type === "infer")).toBe(true);
    const infer = resumed.find((a) => a.type === "infer");
    const options: ExtendedInferenceOptions | undefined =
      infer?.type === "infer" ? infer.options : undefined;
    expect(options?.systemPrompt).toBe("Corbits operating prompt");
  });

  // CL-6910: `timeout`/`retryable` are owned entirely by the harness's own
  // retry policy; the CL-6910 describe above pins the no-reissue contract
  // per category. Here the abort and overflow paths carry the unique legs.
  test("recovers an internally aborted inference but keeps explicit abort terminal", async () => {
    const director = chatDirector("Corbits operating prompt");
    const internalAbort = {
      type: "inference.error",
      error: {
        category: "aborted",
        message: "inference aborted",
        raw: { origin: INFERENCE_ABORT_INTERNAL_RECOVERY },
      },
    } as unknown as ReactorInboundEvent;
    const recovered = actionsArray(
      await director.decide(internalAbort, longState, stubReactorCapabilities),
    );
    expect(recovered.some((action) => action.type === "infer")).toBe(true);
    const infer = recovered.find((action) => action.type === "infer");
    const options: ExtendedInferenceOptions | undefined =
      infer?.type === "infer" ? infer.options : undefined;
    expect(options?.systemPrompt).toBe("Corbits operating prompt");

    const explicitAbort = {
      type: "abort",
      reason: { kind: "operator", message: "cancelled" },
    } as unknown as ReactorInboundEvent;
    const stopped = actionsArray(
      await director.decide(explicitAbort, longState, stubReactorCapabilities),
    );
    expect(stopped.some((action) => action.type === "done")).toBe(true);
    expect(stopped.some((action) => action.type === "infer")).toBe(false);
  });

  test("does not auto-recover user-stop aborted inference errors", async () => {
    const director = chatDirector("");
    const userStopAbort = {
      type: "inference.error",
      error: {
        category: "aborted",
        message: "inference aborted",
        raw: { origin: INFERENCE_ABORT_USER_STOP },
      },
    } as unknown as ReactorInboundEvent;

    const actions = actionsArray(
      await director.decide(userStopAbort, longState, stubReactorCapabilities),
    );
    expect(actions.some((action) => action.type === "infer")).toBe(false);
    expect(
      actions.some(
        (action) =>
          action.type === "checkpoint" &&
          action.message === "inference-recovery",
      ),
    ).toBe(false);
  });

  test("a context_overflow inference error triggers compact-and-retry, not a terminal reply", async () => {
    const director = chatDirector("Corbits operating prompt");
    const actions = actionsArray(
      await director.decide(
        overflowError(),
        longState,
        stubReactorCapabilities,
      ),
    );
    // Continuation is expressed as an emit action the host drives.
    expect(actions).toEqual([
      {
        type: "compact",
        compactor: "pruning-compactor",
        reason: "context-overflow",
      },
      {
        type: "emit",
        eventType: COMPACTION_CONTINUATION_EVENT,
        data: {},
      },
    ]);

    const resumed = actionsArray(
      await director.decide(
        messageReceived(""),
        longState,
        stubReactorCapabilities,
      ),
    );
    expect(resumed.some((a) => a.type === "infer")).toBe(true);
    const infer = resumed.find((a) => a.type === "infer");
    const options: ExtendedInferenceOptions | undefined =
      infer?.type === "infer" ? infer.options : undefined;
    expect(options?.systemPrompt).toBe("Corbits operating prompt");
  });

  test("overflow recovery is bounded so an incompressible history cannot loop forever", async () => {
    const director = chatDirector("");
    for (let i = 0; i < 2; i++) {
      const actions = actionsArray(
        await director.decide(
          overflowError(),
          longState,
          stubReactorCapabilities,
        ),
      );
      expect(actions.some((a) => a.type === "compact")).toBe(true);
      await director.decide(
        messageReceived(""),
        longState,
        stubReactorCapabilities,
      );
    }
    const exhausted = actionsArray(
      await director.decide(
        overflowError(),
        longState,
        stubReactorCapabilities,
      ),
    );
    expect(exhausted.some((a) => a.type === "compact")).toBe(false);
  });

  test("chat posture is preserved: an idle turn never terminates the session", async () => {
    const director = chatDirector("");
    const idle = actionsArray(
      await director.decide(
        textInferenceDone(10),
        longState,
        stubReactorCapabilities,
      ),
    );
    expect(idle.some((a) => a.type === "done")).toBe(false);

    const overThreshold = actionsArray(
      await director.decide(
        textInferenceDone(999_999),
        longState,
        stubReactorCapabilities,
      ),
    );
    expect(overThreshold.some((a) => a.type === "done")).toBe(false);
    const afterCompact = actionsArray(
      await director.decide(
        messageReceived(""),
        longState,
        stubReactorCapabilities,
      ),
    );
    expect(afterCompact.some((a) => a.type === "done")).toBe(false);
  });

  test("restoreCompactInstructions hydrates a rebuilt director from a compact record", () => {
    const written = {
      strategy: "pruning-compactor" as const,
      version: "1",
      parameters: { extraInstructions: "keep the auth discussion" },
      reason: "compacted",
      decisions: {},
    };
    const first = chatDirector("");
    first.restoreCompactInstructions(
      stickyExtraInstructionsFromRecords([written]),
    );
    expect(first.getCompactInstructions()).toBe("keep the auth discussion");

    const rebuilt = chatDirector("");
    expect(rebuilt.getCompactInstructions()).toBeUndefined();
    rebuilt.restoreCompactInstructions(first.getCompactInstructions());
    expect(rebuilt.getCompactInstructions()).toBe("keep the auth discussion");
  });
});

describe("chatDirector LSP auto-activation", () => {
  const activateEmits = (
    actions: ReactorAction | ReactorAction[],
  ): ReactorAction[] =>
    actionsArray(actions).filter(
      (a) =>
        a.type === "emit" &&
        (a as { eventType?: string }).eventType === CHAT_TOOLS_ACTIVATE_EVENT,
    );

  const lspEmit: ReactorAction = {
    type: "emit",
    eventType: CHAT_TOOLS_ACTIVATE_EVENT,
    data: { names: ["lsp"] },
  };

  test.each([
    { tool: "read_file", path: "src/foo.ts", expected: [lspEmit] },
    { tool: "edit_file", path: "lib/bar.rs", expected: [lspEmit] },
    // Non-code file.
    { tool: "read_file", path: "README.md", expected: [] },
    // Failed result never activates.
    {
      tool: "read_file",
      path: "src/foo.ts",
      error: true,
      expected: [],
    },
  ])("$tool on $path", async ({ tool, path, error, expected }) => {
    const director = createChatDirector("", [], {});
    await director.decide(
      makeInferenceDoneEvent([{ id: "c", name: tool, args: { path } }]),
      stubReactorState,
      stubReactorCapabilities,
    );
    const actions = await director.decide(
      error === true
        ? makeToolErrorEvent("c", "Error: not found")
        : makeToolDoneEvent("c"),
      stubReactorState,
      stubReactorCapabilities,
    );
    expect(activateEmits(actions)).toEqual([...expected]);
  });
});

describe("updateToolDefinitions rewrites infer tools", () => {
  const lateTool = {
    name: "mcp__acme__list_issues",
    description: "list",
    inputSchema: { type: "object" },
  };
  const inferToolNames = (
    action: Record<string, unknown> | undefined,
  ): string[] => {
    const tools = (action?.options as Record<string, unknown> | undefined)
      ?.tools;
    return Array.isArray(tools)
      ? tools.map((t) => (t as { name: string }).name)
      : [];
  };

  const inferTools = (action: Record<string, unknown> | undefined): unknown =>
    (action?.options as Record<string, unknown> | undefined)?.tools;
  const decideAndSplit = async (
    director: ReturnType<typeof createChatDirector>,
    event: ReactorInboundEvent,
  ) => {
    const result = await director.decide(
      event,
      stubReactorState,
      capabilitiesWithInferArgs,
    );
    const actions = Array.isArray(result) ? result : [result];
    const inferAction = actions.find((a) => a.type === "infer") as
      | Record<string, unknown>
      | undefined;
    return { actions, inferAction };
  };
  const firstInferTools = async (
    director: ReturnType<typeof createChatDirector>,
    event: ReactorInboundEvent,
  ): Promise<unknown> =>
    inferTools((await decideAndSplit(director, event)).inferAction);

  test("a tool registered after construction is advertised on the next inference", async () => {
    const director = createChatDirector("base-prompt", [], {});
    director.updateToolDefinitions([lateTool]);

    const { inferAction } = await decideAndSplit(
      director,
      messageReceived("hello"),
    );
    expect(inferAction).toBeDefined();
    expect(inferToolNames(inferAction)).toContain("mcp__acme__list_issues");
  });

  // A no-match tool_search must not reshape the tools array.
  test("wire tools are byte-identical across a turn that ran tool_search", async () => {
    const director = createChatDirector("base-prompt", [lateTool], {});

    const before = await firstInferTools(director, messageReceived("do work"));

    // A full tool_search round-trip: the model calls it, it resolves. Under the
    // stable-superset design this promotes nothing, so the advertised set is
    // untouched.
    await director.decide(
      makeInferenceDoneEvent([
        { id: "ts", name: "tool_search", args: { query: "find files" } },
      ]),
      stubReactorState,
      capabilitiesWithInferArgs,
    );
    await director.decide(
      makeToolDoneEvent("ts"),
      stubReactorState,
      capabilitiesWithInferArgs,
    );

    const after = await firstInferTools(director, messageReceived("continue"));
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  // Promoted names join the next infer's tools array (not only after compact).
  test("a tool_search promotion is on the next infer tool list", async () => {
    const linearTool = {
      name: "mcp__linear__list_issues",
      description: "list issues",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    };
    const toolset = await createAgentToolset({
      cwd: process.cwd(),
      permissionGate: createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
        reactorGated: false,
      }),
      onOperatorGate: async () => ({ kind: "cancel" }),
    });
    toolset.dynamicRunner.addTools([
      { kind: "string", definition: linearTool, handler: async () => "ok" },
    ]);

    const advertised = createAdvertisedToolset({
      sessionMode: "orchestrator",
      toolAvailability: { languageServerAvailable: false },
      getProvider: () => ({ providerName: "openai", model: "gpt-5" }),
    });
    const director = createChatDirector(
      "base-prompt",
      advertised.computeAdvertised(toolset.dynamicRunner.currentDefinitions()),
      {},
    );

    const before = await firstInferTools(director, messageReceived("hello"));
    const beforeNames = (before as { name: string }[]).map((t) => t.name);
    expect(beforeNames).not.toContain("mcp__linear__list_issues");

    expect(advertised.activated.activate(["mcp__linear__list_issues"])).toBe(
      true,
    );
    expect(advertised.flushPromotions()).toBe(true);
    director.updateToolDefinitions(
      advertised.computeAdvertised(toolset.dynamicRunner.currentDefinitions()),
    );

    const after = await firstInferTools(director, messageReceived("continue"));
    const afterTools = after as {
      name: string;
      parameters?: unknown;
      inputSchema?: unknown;
    }[];
    const afterNames = afterTools.map((t) => t.name);
    expect(afterNames).toContain("mcp__linear__list_issues");
    const promoted = afterTools.find(
      (t) => t.name === "mcp__linear__list_issues",
    );
    expect(promoted).toBeDefined();
    const schema = promoted?.parameters ?? promoted?.inputSchema;
    expect(schema).toBeDefined();
    expect(typeof schema).toBe("object");

    const beforePrefix = beforeNames.filter((n) => n !== "submit_output");
    const afterPrefix = afterNames.filter(
      (n) => n !== "submit_output" && n !== "mcp__linear__list_issues",
    );
    expect(afterPrefix).toEqual(beforePrefix);

    const stable = await firstInferTools(
      director,
      messageReceived("keep going"),
    );
    expect(JSON.stringify(stable)).toBe(JSON.stringify(after));

    await toolset.dispose();
  });

  // submit_output is always on the wire so a workflow going active never grows
  // the array and busts the provider cache prefix.
  test("submit_output is advertised even with no active workflow", async () => {
    const director = createChatDirector("base-prompt", [], {});
    director.updateToolDefinitions([lateTool]);

    const { inferAction } = await decideAndSplit(
      director,
      messageReceived("hello"),
    );
    expect(inferToolNames(inferAction)).toContain("submit_output");
  });

  // CL-7919: the taskClassifier host closure is gone, so a plain message
  // flows to normal inference with no new-task checkpoint or envelope.
  test("a message with no classifier configured takes the normal infer path", async () => {
    const director = createChatDirector("base-prompt", [], {});
    director.updateToolDefinitions([lateTool]);

    const { actions, inferAction } = await decideAndSplit(
      director,
      messageReceived("new thing"),
    );
    expect(inferAction).toBeDefined();
    expect(inferToolNames(inferAction)).toContain("mcp__acme__list_issues");
    expect(actions.some((a) => a.type === "checkpoint")).toBe(false);
  });
});

describe("CL-7919 coordinator shape", () => {
  const inferEphemeralText = (
    action: ReactorAction | undefined,
  ): string | undefined => {
    if (action?.type !== "infer") return undefined;
    const turns = (action.options as { ephemeralTurns?: unknown } | undefined)
      ?.ephemeralTurns;
    if (!Array.isArray(turns) || turns.length === 0) return undefined;
    const first = turns[0] as { content?: { text?: string }[] };
    return first.content?.[0]?.text;
  };

  // CL-7919: coordination is host-owned and reaches the director only
  // through setWorkflowCoordinator — the constructor takes no coordinator.
  // Attaching a live coordinator injects its directive into the next infer.
  test("setWorkflowCoordinator attaches live coordination to the loop", async () => {
    const { WorkflowRuntime } = await import("../workflows/runtime.js");
    const { WorkflowCoordinator } = await import("../workflows/coordinator.js");
    const workflow = {
      name: "shape",
      description: "setter seam",
      steps: [{ id: "a", label: "A" }],
    };
    const runtime = new WorkflowRuntime(new Map(), () => workflow);
    runtime.start(workflow);
    const director = createChatDirector("base-prompt", [], {});
    director.setWorkflowCoordinator(new WorkflowCoordinator(runtime));

    const actions = actionsArray(
      await director.decide(
        messageReceived("hello"),
        stubReactorState,
        capabilitiesWithInferArgs,
      ),
    );
    const infer = actions.find((a) => a.type === "infer");
    expect(inferEphemeralText(infer)).toContain("[WORKFLOW STEP 1/1: A]");
  });

  // Detaching restores the plain loop: no directive once cleared.
  test("clearing the coordinator removes the directive", async () => {
    const { WorkflowRuntime } = await import("../workflows/runtime.js");
    const { WorkflowCoordinator } = await import("../workflows/coordinator.js");
    const workflow = {
      name: "shape",
      description: "setter seam",
      steps: [{ id: "a", label: "A" }],
    };
    const runtime = new WorkflowRuntime(new Map(), () => workflow);
    runtime.start(workflow);
    const director = createChatDirector("base-prompt", [], {});
    director.setWorkflowCoordinator(new WorkflowCoordinator(runtime));
    director.setWorkflowCoordinator(undefined);

    const actions = actionsArray(
      await director.decide(
        messageReceived("hello"),
        stubReactorState,
        capabilitiesWithInferArgs,
      ),
    );
    const infer = actions.find((a) => a.type === "infer");
    expect(inferEphemeralText(infer)).toBeUndefined();
  });

  // A throwing coordinator degrades to plain inference: decide() resolves
  // with an infer free of the workflow directive instead of rejecting.
  test("a throwing directive falls back to plain inference", async () => {
    const { MAX_WORKFLOW_DIRECTIVE_CHARS } = await import("./director.js");
    expect(MAX_WORKFLOW_DIRECTIVE_CHARS).toBeGreaterThan(0);
    const director = createChatDirector("base-prompt", [], {});
    director.setWorkflowCoordinator({
      directive: () => {
        throw new Error("boom");
      },
      isActive: () => true,
      currentStepIsGate: () => false,
      currentStepId: () => "a",
      handleToolDone: () => false,
    } as unknown as WorkflowCoordinator);
    const actions = actionsArray(
      await director.decide(
        messageReceived("hello"),
        stubReactorState,
        capabilitiesWithInferArgs,
      ),
    );
    const infer = actions.find((a) => a.type === "infer");
    expect(infer).toBeDefined();
    expect(inferEphemeralText(infer)).toBeUndefined();
  });

  // Every per-turn consult is guarded, not just directive(): a coordinator
  // whose rails all throw still lets decide() (including the tool.done
  // handleToolDone path) resolve to the plain loop.
  test("throwing idle rails and handleToolDone fall back to the plain loop", async () => {
    const director = createChatDirector("base-prompt", [], {});
    director.setWorkflowCoordinator({
      directive: () => {
        throw new Error("directive boom");
      },
      isActive: () => {
        throw new Error("active boom");
      },
      currentStepIsGate: () => {
        throw new Error("gate boom");
      },
      currentStepId: () => {
        throw new Error("step boom");
      },
      handleToolDone: () => {
        throw new Error("tool boom");
      },
    } as unknown as WorkflowCoordinator);
    const fromMessage = actionsArray(
      await director.decide(
        messageReceived("hello"),
        stubReactorState,
        capabilitiesWithInferArgs,
      ),
    );
    expect(fromMessage.find((a) => a.type === "infer")).toBeDefined();
    const fromToolDone = actionsArray(
      await director.decide(
        {
          type: "tool.done",
          result: { callId: "missing", content: "ok" },
        } as unknown as ReactorInboundEvent,
        stubReactorState,
        capabilitiesWithInferArgs,
      ),
    );
    expect(fromToolDone.length).toBeGreaterThan(0);
  });

  // The setter is the shape boundary: a lookalike missing coordinator
  // members is rejected with a clear error instead of failing a turn later.
  test("setWorkflowCoordinator rejects a misshapen coordinator", async () => {
    const director = createChatDirector("base-prompt", [], {});
    expect(() =>
      director.setWorkflowCoordinator({
        isActive: () => true,
      } as unknown as Parameters<typeof director.setWorkflowCoordinator>[0]),
    ).toThrow(/setWorkflowCoordinator.*invalid coordinator/);
  });

  // An oversized directive is capped with a marker, never dropped: the turn
  // still carries workflow guidance within the bound.
  test("an oversized directive is capped with a truncation marker", async () => {
    const { MAX_WORKFLOW_DIRECTIVE_CHARS } = await import("./director.js");
    const director = createChatDirector("base-prompt", [], {});
    const oversized = `prefix ${"x".repeat(MAX_WORKFLOW_DIRECTIVE_CHARS + 100)}`;
    director.setWorkflowCoordinator({
      directive: () => oversized,
      isActive: () => true,
      currentStepIsGate: () => false,
      currentStepId: () => "a",
      handleToolDone: () => false,
    } as unknown as WorkflowCoordinator);
    const actions = actionsArray(
      await director.decide(
        messageReceived("hello"),
        stubReactorState,
        capabilitiesWithInferArgs,
      ),
    );
    const text = inferEphemeralText(actions.find((a) => a.type === "infer"));
    expect(text).toBeDefined();
    expect(text).toContain("…[truncated]");
    expect(text?.startsWith("prefix")).toBe(true);
    expect(text?.length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      MAX_WORKFLOW_DIRECTIVE_CHARS + "…[truncated]".length + 1,
    );
  });

  // A step id that cannot be interpolated — non-string or empty — never
  // reaches prompt text: the stall nudge falls back to the generic clause.
  test.each([
    ["non-string", 42, "42"],
    ["empty", "", '{ "step": "" }'],
  ])(
    "an invalid step id (%s) falls back to the generic submit_output clause",
    async (_kind, stepId, absent) => {
      const director = createChatDirector("base-prompt", [], {});
      director.setWorkflowCoordinator({
        directive: () => "do the thing",
        isActive: () => true,
        currentStepIsGate: () => false,
        currentStepId: () => stepId,
        handleToolDone: () => false,
      } as unknown as WorkflowCoordinator);
      const actions = actionsArray(
        await director.decide(
          stubTextTurnEvent(),
          stubReactorState,
          capabilitiesWithInferArgs,
        ),
      );
      const text = inferEphemeralText(actions.find((a) => a.type === "infer"));
      // A stall nudge still fires; the invalid id just never reaches its text.
      expect(typeof text).toBe("string");
      expect(text).not.toContain(absent);
    },
  );

  // An empty directive is absent guidance: no ephemeral turn is appended
  // and the turn resolves as plain inference.
  test("an empty-string directive resolves as plain inference", async () => {
    const director = createChatDirector("base-prompt", [], {});
    director.setWorkflowCoordinator({
      directive: () => "",
      isActive: () => true,
      currentStepIsGate: () => false,
      currentStepId: () => "a",
      handleToolDone: () => false,
    } as unknown as WorkflowCoordinator);
    const actions = actionsArray(
      await director.decide(
        messageReceived("hello"),
        stubReactorState,
        capabilitiesWithInferArgs,
      ),
    );
    const infer = actions.find((a) => a.type === "infer");
    expect(infer).toBeDefined();
    expect(inferEphemeralText(infer)).toBeUndefined();
  });
});

describe("submit_output workflow handler", () => {
  const buildToolset = (opts: {
    isWorkflowActive: () => boolean;
    completeWorkflowStep?: (
      stepId: string,
    ) => "advanced" | "already-complete" | "not-current";
  }) =>
    createAgentToolset({
      cwd: process.cwd(),
      permissionGate: createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
        reactorGated: false,
      }),
      onOperatorGate: async () => ({ kind: "cancel" }),
      isWorkflowActive: opts.isWorkflowActive,
      ...(opts.completeWorkflowStep !== undefined
        ? { completeWorkflowStep: opts.completeWorkflowStep }
        : {}),
    });

  const runSubmit = async (
    toolset: Awaited<ReturnType<typeof createAgentToolset>>,
    args: Record<string, unknown>,
  ) => {
    const result = await toolset.dynamicRunner.run(
      { id: "so", name: "submit_output", arguments: args },
      new AbortController().signal,
    );
    await toolset.dispose();
    return String(result.content);
  };

  test("reports an honest no-op when no workflow is active and a step is tagged", async () => {
    const content = await runSubmit(
      await buildToolset({ isWorkflowActive: () => false }),
      {
        step: "a",
      },
    );
    expect(content).toContain("No active workflow");
    expect(content).not.toContain("Advancing");
  });

  test("requires a step identifier while a workflow is active", async () => {
    const content = await runSubmit(
      await buildToolset({
        isWorkflowActive: () => true,
        completeWorkflowStep: () => "advanced",
      }),
      { summary: "done" },
    );
    expect(content).toContain("requires a step identifier");
    expect(content).not.toContain("Advancing");
  });

  test("reports complete() when the step advances", async () => {
    const content = await runSubmit(
      await buildToolset({
        isWorkflowActive: () => true,
        completeWorkflowStep: (id) => (id === "a" ? "advanced" : "not-current"),
      }),
      { step: "a" },
    );
    expect(content).toContain("Advancing to the next step");
  });

  test("reports already-complete without claiming an advance", async () => {
    const content = await runSubmit(
      await buildToolset({
        isWorkflowActive: () => true,
        completeWorkflowStep: () => "already-complete",
      }),
      { step: "a" },
    );
    expect(content).toContain("already complete");
    expect(content).not.toContain("Advancing");
  });

  test("does not report a not-current step as already complete", async () => {
    const content = await runSubmit(
      await buildToolset({
        isWorkflowActive: () => true,
        completeWorkflowStep: () => "not-current",
      }),
      { step: "b" },
    );
    expect(content).toContain("not current");
    expect(content).not.toContain("already complete");
    expect(content).not.toContain("Advancing");
  });

  test("omitted completeWorkflowStep does not claim an advance", async () => {
    const content = await runSubmit(
      await buildToolset({ isWorkflowActive: () => true }),
      {
        step: "a",
      },
    );
    expect(content).toContain("not current");
    expect(content).not.toContain("Advancing");
  });

  test("parallel submit_output only one reports Advancing", async () => {
    const { WorkflowRuntime } = await import("../workflows/runtime.js");
    const workflow = {
      name: "simple",
      description: "two steps",
      steps: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    };
    const runtime = new WorkflowRuntime(new Map(), () => workflow);
    runtime.start(workflow);
    const toolset = await buildToolset({
      isWorkflowActive: () => true,
      completeWorkflowStep: (stepId) => runtime.complete(stepId),
    });
    const run = (id: string, step: string) =>
      toolset.dynamicRunner.run(
        { id, name: "submit_output", arguments: { step } },
        new AbortController().signal,
      );
    const [first, second] = await Promise.all([
      run("so-1", "a"),
      run("so-2", "a"),
    ]);
    await toolset.dispose();
    const contents = [String(first.content), String(second.content)];
    expect(contents.filter((c) => c.includes("Advancing"))).toHaveLength(1);
    expect(contents.filter((c) => c.includes("already complete"))).toHaveLength(
      1,
    );
    expect(runtime.currentStep()?.id).toBe("b");
  });
});

describe("transient nudges", () => {
  test("open-task nudge uses ephemeralTurns and keeps the stable system prompt", async () => {
    const director = createChatDirector("stable-base", [], {});
    await director.decide(
      manageTasksEvent("doing"),
      stubReactorState,
      stubReactorCapabilities,
    );
    const actions = actionsArray(
      await director.decide(
        stubTextTurnEvent(),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    const infer = actions.find((a) => a.type === "infer");
    // Plain annotation, not a cast: InferenceOptions is assignable to the
    // extended type, which only adds an optional member.
    const options: ExtendedInferenceOptions | undefined =
      infer?.type === "infer" ? infer.options : undefined;
    expect(options?.ephemeralTurns?.length ?? 0).toBeGreaterThan(0);
    const nudgeText = options?.ephemeralTurns?.[0]?.content?.find(
      (b) => b.type === "text",
    );
    expect(nudgeText?.type).toBe("text");
    expect(nudgeText?.type === "text" ? nudgeText.text : "").not.toBe("");
    expect(options?.systemPrompt).toBe("stable-base");
  });
});

describe("chatDirector spacer echo", () => {
  function spacerInferenceDone(text: string): ReactorInboundEvent {
    return {
      type: "inference.done",
      turn: {
        role: "assistant",
        model: "omen-alpha",
        timestamp: 0,
        content: [{ type: "text", text }],
      },
      usage: {
        input: 999_999,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      },
      source: { model: "omen-alpha" },
    } as unknown as ReactorInboundEvent;
  }

  test("spacer-only assistant reply is not a finished turn", async () => {
    for (const text of [LEGACY_COMPACT_SPACER_TEXT, COMPACT_SPACER_TEXT]) {
      const director = createChatDirector("base", [], {});
      const actions = actionsArray(
        await director.decide(
          spacerInferenceDone(text),
          stubReactorState,
          stubReactorCapabilities,
        ),
      );
      expect(actions.some((a) => a.type === "infer")).toBe(true);
      expect(
        actions.some(
          (a) => a.type === "reply" && "content" in a && a.content === text,
        ),
      ).toBe(false);
    }
  });

  test("spacer-echo does not arm idle compact, including after the nudge cap", async () => {
    const director = createChatDirector("base", [], {});
    const hasContinuationEmit = (actions: ReactorAction[]) =>
      actions.some(
        (a) =>
          a.type === "emit" &&
          "eventType" in a &&
          a.eventType === COMPACTION_CONTINUATION_EVENT,
      );
    for (let i = 0; i < 2; i++) {
      const nudged = actionsArray(
        await director.decide(
          spacerInferenceDone(LEGACY_COMPACT_SPACER_TEXT),
          longState,
          stubReactorCapabilities,
        ),
      );
      expect(nudged.some((a) => a.type === "infer")).toBe(true);
      expect(hasContinuationEmit(nudged)).toBe(false);
    }
    const settled = actionsArray(
      await director.decide(
        spacerInferenceDone(COMPACT_SPACER_TEXT),
        longState,
        stubReactorCapabilities,
      ),
    );
    expect(settled.some((a) => a.type === "infer")).toBe(false);
    expect(
      settled.some(
        (a) => a.type === "reply" && "content" in a && a.content === "",
      ),
    ).toBe(true);
    expect(hasContinuationEmit(settled)).toBe(false);
  });

  test("echo-nudge cap is two then empty settle, and resets on message.received", async () => {
    const director = createChatDirector("base", [], {});
    for (let i = 0; i < 2; i++) {
      const nudged = actionsArray(
        await director.decide(
          spacerInferenceDone(LEGACY_COMPACT_SPACER_TEXT),
          stubReactorState,
          stubReactorCapabilities,
        ),
      );
      expect(nudged.some((a) => a.type === "infer")).toBe(true);
      expect(nudged.some((a) => a.type === "reply")).toBe(false);
    }
    const exhausted = actionsArray(
      await director.decide(
        spacerInferenceDone(COMPACT_SPACER_TEXT),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(exhausted.some((a) => a.type === "infer")).toBe(false);
    expect(
      exhausted.some(
        (a) => a.type === "reply" && "content" in a && a.content === "",
      ),
    ).toBe(true);

    await director.decide(
      messageReceived("keep going"),
      stubReactorState,
      stubReactorCapabilities,
    );
    const afterReset = actionsArray(
      await director.decide(
        spacerInferenceDone(LEGACY_COMPACT_SPACER_TEXT),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(afterReset.some((a) => a.type === "infer")).toBe(true);
  });

  test("after echo-cap with open tasks, falls through to open-task rails", async () => {
    const director = createChatDirector("base", [], {});
    await director.decide(
      makeInferenceDoneEvent([
        {
          id: "mt",
          name: "manage_tasks",
          args: {
            action: "create",
            tasks: [{ id: "t1", title: "work", status: "doing" }],
          },
        },
      ]),
      stubReactorState,
      stubReactorCapabilities,
    );
    for (let i = 0; i < 2; i++) {
      const nudged = actionsArray(
        await director.decide(
          spacerInferenceDone(LEGACY_COMPACT_SPACER_TEXT),
          stubReactorState,
          stubReactorCapabilities,
        ),
      );
      expect(nudged.some((a) => a.type === "infer")).toBe(true);
    }
    const afterCap = actionsArray(
      await director.decide(
        spacerInferenceDone(COMPACT_SPACER_TEXT),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(afterCap.some((a) => a.type === "infer")).toBe(true);
    expect(
      afterCap.some(
        (a) => a.type === "reply" && "content" in a && a.content === "",
      ),
    ).toBe(false);
    for (let i = 0; i < 2; i++) {
      const nudged = actionsArray(
        await director.decide(
          spacerInferenceDone(COMPACT_SPACER_TEXT),
          stubReactorState,
          stubReactorCapabilities,
        ),
      );
      expect(nudged.some((a) => a.type === "infer")).toBe(true);
    }
    const exhausted = actionsArray(
      await director.decide(
        spacerInferenceDone(COMPACT_SPACER_TEXT),
        stubReactorState,
        stubReactorCapabilities,
      ),
    );
    expect(exhausted.some((a) => a.type === "infer")).toBe(false);
    expect(exhausted.some((a) => a.type === "reply")).toBe(true);
  });
});

// The rules are only worth anything if they reach the model. An earlier cut of
// this change appended them to the director's own copy of the system prompt
// AFTER calling super(), so the base director kept sending the original and
// the whole feature was a no-op that every existing test passed.
describe("tool-discipline rules on the wire", () => {
  async function promptSentFor(model: string): Promise<string | undefined> {
    const director = createChatDirector("BASE PROMPT", [], {
      provider: { providerName: "opencode-go", model },
    });
    const event = {
      type: "message.received",
      message: { role: "user", content: "hi" },
    } as unknown as ReactorInboundEvent;
    const actions = actionsArray(
      await director.decide(event, stubReactorState, stubReactorCapabilities),
    );
    const infer = actions.find((a) => a.type === "infer") as
      | { options?: ExtendedInferenceOptions }
      | undefined;
    return infer?.options?.systemPrompt;
  }

  test("a Muse Spark session appends rules at the tail, leaving the base prefix intact", async () => {
    const prompt = await promptSentFor("muse-spark-1.3-contributor");
    expect(prompt?.startsWith("BASE PROMPT")).toBe(true);
    expect(prompt?.length ?? 0).toBeGreaterThan("BASE PROMPT".length);
  });

  test("a family with no rules sends the prompt untouched", async () => {
    expect(await promptSentFor("claude-sonnet-4")).toBe("BASE PROMPT");
  });
});
