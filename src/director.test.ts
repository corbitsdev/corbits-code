import { describe, test, expect } from "bun:test";
import {
  createChatDirector,
  askOperatorDefinition,
  CHAT_TASKS_CHANGED_EVENT,
  CHAT_TOOLS_ACTIVATE_EVENT,
} from "./agent/director.js";
import { createAgentToolset } from "./agent/tools.js";
import { createAdvertisedToolset } from "./session/assemble-runtime.js";
import { createPermissionGate } from "./permission/gate.js";
import {
  COMPACTOR_KEEP_RECENT_TURNS,
  COMPACT_SPACER_TEXT,
  LEGACY_COMPACT_SPACER_TEXT,
  compactorNoOpFloor,
} from "./session/compactor.js";
import type { SessionMetadata, TaskBoundary } from "./session/compactor.js";
import {
  validateActions,
  type ExtendedInferenceOptions,
} from "@intx/inference";
import type {
  ReactorState,
  ReactorCapabilities,
  ReactorAction,
  ReactorInboundEvent,
} from "@intx/types/runtime";
import {
  INFERENCE_ABORT_INTERNAL_RECOVERY,
  INFERENCE_ABORT_USER_STOP,
} from "./inference-abort.js";

const mockState: ReactorState = {} as unknown as ReactorState;

const mockCapabilities: ReactorCapabilities = {
  infer: (options) =>
    ({
      type: "infer",
      ...(options !== undefined ? { options } : {}),
    }) as ReactorAction,
  executeTools: (calls) => ({ type: "execute_tools", calls }),
  suspend: (gate) => ({ type: "suspend", gate }),
  fork: (mode, forkId) => ({ type: "fork", mode, forkId }),
  emit: (eventType, data) => ({ type: "emit", eventType, data }),
  reply: (content) => ({ type: "reply", content }),
  checkpoint: (message = "") => ({ type: "checkpoint", message }),
  compact: (compactor, reason) => ({ type: "compact", compactor, reason }),
  wait: () => ({ type: "wait" }),
  done: () => ({ type: "done" }),
};

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

function actionsArray(
  result: ReactorAction | ReactorAction[],
): ReactorAction[] {
  return Array.isArray(result) ? result : [result];
}

describe("ask_operator definition", () => {
  test("has no command field and does not advertise shell preauthorization", () => {
    const schema = askOperatorDefinition.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties).not.toHaveProperty("command");
    expect(askOperatorDefinition.description).not.toMatch(/pre-authoriz/i);
    expect(askOperatorDefinition.description).not.toMatch(/`command`/);
    expect(askOperatorDefinition.description).toMatch(/at most 48 characters/);
    const options = schema.properties?.options as {
      items?: { maxLength?: number };
    };
    expect(options.items?.maxLength).toBe(48);
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
        mockState,
        mockCapabilities,
      ),
    );
    expect(hasCheckpoint(actions)).toBe(true);
    expect(hasDeclineReply(actions)).toBe(true);
    // No done(): the TUI must stay alive so the user can send another message.
    expect(hasDone(actions)).toBe(false);
    expect(hasInfer(actions)).toBe(false);
  });

  // Reactor path: a reason-bearing approver rejection must re-infer so the
  // model can respond to the reason — never the canned decline.
  test("reason-bearing approver rejection re-infers on the reason", async () => {
    const director = createChatDirector("", [], {});
    const actions = actionsArray(
      await director.decide(
        makeToolErrorEvent("c", "denied by approver: never touch /etc"),
        mockState,
        mockCapabilities,
      ),
    );
    expect(hasInfer(actions)).toBe(true);
    expect(hasDeclineReply(actions)).toBe(false);
    expect(hasCheckpoint(actions)).toBe(false);
  });

  test("middleware rejection with a reason re-infers on the reason", async () => {
    const director = createChatDirector("", [], {});
    const actions = actionsArray(
      await director.decide(
        makeToolErrorEvent(
          "c",
          `${declined} — only run it in the build sandbox`,
        ),
        mockState,
        mockCapabilities,
      ),
    );
    expect(hasInfer(actions)).toBe(true);
    expect(hasDeclineReply(actions)).toBe(false);
    expect(hasCheckpoint(actions)).toBe(false);
  });

  // Reactor path: a reason-less approver rejection has nothing for the model
  // to respond to; the canned reply stands.
  test("reason-less approver rejection takes the canned path", async () => {
    const director = createChatDirector("", [], {});
    const actions = actionsArray(
      await director.decide(
        makeToolErrorEvent("c", "denied by approver"),
        mockState,
        mockCapabilities,
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
          mockState,
          mockCapabilities,
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

  const manageTasksEvent = (status: "todo" | "doing" | "done") =>
    makeInferenceDoneEvent([
      {
        id: "m",
        name: "manage_tasks",
        args: {
          action: "create",
          tasks: [{ id: "t1", title: "work", status }],
        },
      },
    ]);

  const textTurn = (): ReactorInboundEvent =>
    ({
      type: "inference.done",
      turn: {
        role: "assistant",
        model: "test",
        timestamp: 0,
        content: [{ type: "text", text: "all set" }],
      },
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { model: "test-model" },
    }) as unknown as ReactorInboundEvent;

  const hasInfer = (a: ReactorAction[]): boolean =>
    a.some((x) => x.type === "infer");
  const hasReply = (a: ReactorAction[]): boolean =>
    a.some((x) => x.type === "reply");

  test("re-infers instead of ending the turn while a task is still open", async () => {
    const director = createChatDirector("base", [], {});
    await director.decide(
      manageTasksEvent("doing"),
      mockState,
      mockCapabilities,
    );

    const actions = actionsArray(
      await director.decide(textTurn(), mockState, mockCapabilities),
    );
    expect(hasInfer(actions)).toBe(true);
    expect(hasReply(actions)).toBe(false);
  });

  test("ends the turn normally once every task is terminal", async () => {
    const director = createChatDirector("base", [], {});
    await director.decide(
      manageTasksEvent("done"),
      mockState,
      mockCapabilities,
    );

    const actions = actionsArray(
      await director.decide(textTurn(), mockState, mockCapabilities),
    );
    expect(hasReply(actions)).toBe(true);
    expect(hasInfer(actions)).toBe(false);
  });

  test("a task change emits the updated task list on the chat event", async () => {
    const director = createChatDirector("base", [], {});
    const actions = actionsArray(
      await director.decide(
        manageTasksEvent("doing"),
        mockState,
        mockCapabilities,
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
      mockState,
      mockCapabilities,
    );

    for (let i = 0; i < 3; i++) {
      const nudged = actionsArray(
        await director.decide(textTurn(), mockState, mockCapabilities),
      );
      expect(hasInfer(nudged)).toBe(true);
    }
    const exhausted = actionsArray(
      await director.decide(textTurn(), mockState, mockCapabilities),
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
      mockState,
      mockCapabilities,
    );

    for (let i = 0; i < 4; i++) {
      const actions = actionsArray(
        await director.decide(textTurn(), mockState, mockCapabilities),
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
      mockState,
      mockCapabilities,
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
      await director.decide(textTurn(), mockState, mockCapabilities),
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
      mockState,
      mockCapabilities,
    );
    const after = actionsArray(
      await director.decide(textTurn(), mockState, mockCapabilities),
    );
    expect(await inferPolicyOf(after)(bare429)).toEqual({
      kind: "retry",
      delayMs: 45_000,
    });
  });

  test("omitted or false idle-with-fleet still nudges while a task is open", async () => {
    const omitted = createChatDirector("base", [], {});
    await omitted.decide(
      manageTasksEvent("doing"),
      mockState,
      mockCapabilities,
    );
    expect(
      hasInfer(
        actionsArray(
          await omitted.decide(textTurn(), mockState, mockCapabilities),
        ),
      ),
    ).toBe(true);

    const disabled = createChatDirector("base", [], {
      allowIdleWithFleet: false,
    });
    await disabled.decide(
      manageTasksEvent("doing"),
      mockState,
      mockCapabilities,
    );
    expect(
      hasInfer(
        actionsArray(
          await disabled.decide(textTurn(), mockState, mockCapabilities),
        ),
      ),
    ).toBe(true);
  });

  test("setAllowIdleWithFleet tracks fleet transitions off the seeded value", async () => {
    const director = createChatDirector("base", [], {
      allowIdleWithFleet: true,
    });
    await director.decide(
      manageTasksEvent("doing"),
      mockState,
      mockCapabilities,
    );

    // Seeded allowance: terminal reply with open tasks, no nudge spent.
    const seeded = actionsArray(
      await director.decide(textTurn(), mockState, mockCapabilities),
    );
    expect(hasReply(seeded)).toBe(true);
    expect(hasInfer(seeded)).toBe(false);

    // Drained fleet resumes the open-task nudge.
    director.setAllowIdleWithFleet(false);
    const nudged = actionsArray(
      await director.decide(textTurn(), mockState, mockCapabilities),
    );
    expect(hasInfer(nudged)).toBe(true);
    expect(hasReply(nudged)).toBe(false);

    // Fleet back: terminal allowed again.
    director.setAllowIdleWithFleet(true);
    const settled = actionsArray(
      await director.decide(textTurn(), mockState, mockCapabilities),
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
      await director.decide(emptyTurn, mockState, mockCapabilities),
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
      mockState,
      mockCapabilities,
    );

    for (let i = 0; i < 2; i++) {
      const nudged = actionsArray(
        await director.decide(
          makeToolErrorEvent("c", declined),
          mockState,
          mockCapabilities,
        ),
      );
      expect(nudged.some((a) => a.type === "infer")).toBe(true);
      expect(nudged.some((a) => a.type === "reply")).toBe(false);
    }
    const ended = actionsArray(
      await director.decide(
        makeToolErrorEvent("c", declined),
        mockState,
        mockCapabilities,
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
      mockState,
      mockCapabilities,
    );

    // Two content-free terminations spend two of the three nudges.
    expect(
      hasInfer(
        actionsArray(
          await director.decide(textTurn(), mockState, mockCapabilities),
        ),
      ),
    ).toBe(true);
    expect(
      hasInfer(
        actionsArray(
          await director.decide(textTurn(), mockState, mockCapabilities),
        ),
      ),
    ).toBe(true);

    // A no-op shell call (echo) is not a new user turn, so it must not buy
    // back budget.
    await director.decide(
      makeInferenceDoneEvent([
        { id: "e", name: "run_shell", args: { command: "echo done" } },
      ]),
      mockState,
      mockCapabilities,
    );

    // Only one nudge remains from the original budget of three.
    const nudged = actionsArray(
      await director.decide(textTurn(), mockState, mockCapabilities),
    );
    expect(hasInfer(nudged)).toBe(true);
    const ended = actionsArray(
      await director.decide(textTurn(), mockState, mockCapabilities),
    );
    expect(hasReply(ended)).toBe(true);
    expect(hasInfer(ended)).toBe(false);
  });

  test("a new user message resets the idle budget for the next turn", async () => {
    const director = createChatDirector("base", [], {});
    await director.decide(
      manageTasksEvent("doing"),
      mockState,
      mockCapabilities,
    );

    for (let i = 0; i < 3; i++) {
      expect(
        hasInfer(
          actionsArray(
            await director.decide(textTurn(), mockState, mockCapabilities),
          ),
        ),
      ).toBe(true);
    }
    const exhausted = actionsArray(
      await director.decide(textTurn(), mockState, mockCapabilities),
    );
    expect(hasReply(exhausted)).toBe(true);

    // A fresh inbound user message starts a new turn: the budget is restored.
    await director.decide(
      {
        type: "message.received",
        message: { role: "user", content: "keep going" },
      } as unknown as ReactorInboundEvent,
      mockState,
      mockCapabilities,
    );
    const nudged = actionsArray(
      await director.decide(textTurn(), mockState, mockCapabilities),
    );
    expect(hasInfer(nudged)).toBe(true);
  });

  test("a successful tool call between declines does not reset the declined budget", async () => {
    const director = createChatDirector("base", [], {});
    await director.decide(
      manageTasksEvent("doing"),
      mockState,
      mockCapabilities,
    );

    // Spend both of the declined-path nudges, with a successful tool result
    // interleaved after the first. If the successful result reset the budget,
    // a third decline would still re-infer instead of terminating.
    const first = actionsArray(
      await director.decide(
        makeToolErrorEvent("c", declined),
        mockState,
        mockCapabilities,
      ),
    );
    expect(first.some((a) => a.type === "infer")).toBe(true);

    // A successful (non-error) tool result in between must not buy back budget.
    await director.decide(
      makeToolDoneEvent("ok1"),
      mockState,
      mockCapabilities,
    );

    const second = actionsArray(
      await director.decide(
        makeToolErrorEvent("c", declined),
        mockState,
        mockCapabilities,
      ),
    );
    expect(second.some((a) => a.type === "infer")).toBe(true);

    const third = actionsArray(
      await director.decide(
        makeToolErrorEvent("c", declined),
        mockState,
        mockCapabilities,
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

  test("a declined tool with no open tasks surfaces the decline immediately", async () => {
    const director = createChatDirector("base", [], {});
    const actions = actionsArray(
      await director.decide(
        makeToolErrorEvent("c", declined),
        mockState,
        mockCapabilities,
      ),
    );
    expect(
      actions.some(
        (a) =>
          a.type === "reply" &&
          "content" in a &&
          a.content === "Tool call rejected by operator.",
      ),
    ).toBe(true);
    expect(actions.some((a) => a.type === "infer")).toBe(false);
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

  function messageReceived(content: string): ReactorInboundEvent {
    return {
      type: "message.received",
      message: { role: "user", content },
    } as unknown as ReactorInboundEvent;
  }

  test("schedules idle compaction after an over-threshold text-only reply", async () => {
    let continuations = 0;
    const director = createChatDirector("", [], {
      requestContinuation: () => {
        continuations++;
      },
    });
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

    const replyActions = actionsArray(
      await director.decide(
        textInferenceDone(999_999),
        longState,
        mockCapabilities,
      ),
    );
    expect(replyActions.some((a) => a.type === "reply")).toBe(true);
    expect(replyActions.some((a) => a.type === "compact")).toBe(false);
    expect(continuations).toBe(1);

    const compactActions = actionsArray(
      await director.decide(messageReceived(""), longState, mockCapabilities),
    );
    expect(compactActions).toEqual([
      {
        type: "compact",
        compactor: "pruning-compactor",
        reason: "context-threshold",
      },
    ]);
    // Idle empty compact schedules a second continuation so decide can adopt
    // the shrunk turns for the meter without starting a new inference.
    expect(continuations).toBe(2);
  });

  test("idle empty compact makes the post-compact estimate authoritative without inferring", async () => {
    const director = createChatDirector("", [], {
      requestContinuation: () => undefined,
    });
    const largeTurns = Array.from(
      { length: compactorNoOpFloor(COMPACTOR_KEEP_RECENT_TURNS) + 1 },
      (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: "x".repeat(200) }],
        timestamp: i,
      }),
    );
    const longState = { turns: largeTurns } as unknown as ReactorState;

    await director.decide(
      textInferenceDone(999_999),
      longState,
      mockCapabilities,
    );
    expect(director.getContextEstimate().isEstimate).toBe(false);
    const before = director.getContextEstimate().tokens;

    await director.decide(messageReceived(""), longState, mockCapabilities);

    // Simulate the reactor having compacted, then the meter-sync continuation.
    const shrunkTurns = largeTurns.slice(-3);
    const shrunkState = { turns: shrunkTurns } as unknown as ReactorState;
    const afterActions = actionsArray(
      await director.decide(messageReceived(""), shrunkState, mockCapabilities),
    );
    expect(afterActions.some((a) => a.type === "infer")).toBe(false);
    expect(
      afterActions.some((a) => a.type === "wait" || a.type === "reply"),
    ).toBe(true);

    const estimate = director.getContextEstimate();
    expect(estimate.isEstimate).toBe(true);
    expect(estimate.tokens).toBeLessThan(before);
  });

  // One turn past createPruningCompactor's own no-op floor (session/compactor.ts).
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

  function chatDirectorWithContinuation(
    systemPrompt: string,
    onContinuation?: () => void,
  ) {
    return createChatDirector(systemPrompt, [], {
      requestContinuation: onContinuation ?? (() => undefined),
    });
  }

  test("compacts at the tool.done pause once over threshold", async () => {
    const director = chatDirectorWithContinuation("Corbits operating prompt");
    await director.decide(overThresholdToolTurn(), longState, mockCapabilities);
    const actions = actionsArray(
      await director.decide(
        makeToolDoneEvent("t1"),
        longState,
        mockCapabilities,
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
      await director.decide(messageReceived(""), longState, mockCapabilities),
    );
    expect(resumed.some((a) => a.type === "infer")).toBe(true);
    const infer = resumed.find((a) => a.type === "infer");
    const options: ExtendedInferenceOptions | undefined =
      infer?.type === "infer" ? infer.options : undefined;
    expect(options?.systemPrompt).toBe("Corbits operating prompt");
  });

  // CL-6910: `timeout`/`retryable` are owned entirely by the harness's own
  // retry policy, which already retries and exhausts them before an
  // `inference.error` of one of those categories ever reaches the director.
  // The director re-issuing another `infer()` here used to multiply with
  // the harness's own attempts (up to 9 identical full-context sends per
  // turn); it now falls through to the base director's terminal
  // checkpoint + reply instead of recovering.
  test("does not re-issue inference for a timeout already exhausted by the harness", async () => {
    const director = chatDirectorWithContinuation("");
    const timeout = {
      type: "inference.error",
      error: { category: "timeout", message: "request timed out" },
    } as unknown as ReactorInboundEvent;

    const actions = actionsArray(
      await director.decide(timeout, longState, mockCapabilities),
    );
    expect(actions.some((action) => action.type === "infer")).toBe(false);
    expect(actions.some((action) => action.type === "reply")).toBe(true);
  });

  test("recovers an internally aborted inference but keeps explicit abort terminal", async () => {
    const director = chatDirectorWithContinuation("Corbits operating prompt");
    const internalAbort = {
      type: "inference.error",
      error: {
        category: "aborted",
        message: "inference aborted",
        raw: { origin: INFERENCE_ABORT_INTERNAL_RECOVERY },
      },
    } as unknown as ReactorInboundEvent;
    const recovered = actionsArray(
      await director.decide(internalAbort, longState, mockCapabilities),
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
      await director.decide(explicitAbort, longState, mockCapabilities),
    );
    expect(stopped.some((action) => action.type === "done")).toBe(true);
    expect(stopped.some((action) => action.type === "infer")).toBe(false);
  });

  test("does not auto-recover user-stop aborted inference errors", async () => {
    const director = chatDirectorWithContinuation("");
    const userStopAbort = {
      type: "inference.error",
      error: {
        category: "aborted",
        message: "inference aborted",
        raw: { origin: INFERENCE_ABORT_USER_STOP },
      },
    } as unknown as ReactorInboundEvent;

    const actions = actionsArray(
      await director.decide(userStopAbort, longState, mockCapabilities),
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
    let continuations = 0;
    const director = chatDirectorWithContinuation(
      "Corbits operating prompt",
      () => continuations++,
    );
    const actions = actionsArray(
      await director.decide(overflowError(), longState, mockCapabilities),
    );
    expect(actions).toEqual([
      {
        type: "compact",
        compactor: "pruning-compactor",
        reason: "context-overflow",
      },
    ]);
    expect(continuations).toBe(1);

    const resumed = actionsArray(
      await director.decide(messageReceived(""), longState, mockCapabilities),
    );
    expect(resumed.some((a) => a.type === "infer")).toBe(true);
    const infer = resumed.find((a) => a.type === "infer");
    const options: ExtendedInferenceOptions | undefined =
      infer?.type === "infer" ? infer.options : undefined;
    expect(options?.systemPrompt).toBe("Corbits operating prompt");
  });

  test("overflow recovery is bounded so an incompressible history cannot loop forever", async () => {
    const director = chatDirectorWithContinuation("");
    for (let i = 0; i < 2; i++) {
      const actions = actionsArray(
        await director.decide(overflowError(), longState, mockCapabilities),
      );
      expect(actions.some((a) => a.type === "compact")).toBe(true);
      await director.decide(messageReceived(""), longState, mockCapabilities);
    }
    const exhausted = actionsArray(
      await director.decide(overflowError(), longState, mockCapabilities),
    );
    expect(exhausted.some((a) => a.type === "compact")).toBe(false);
  });

  test("chat posture is preserved: an idle turn never terminates the session", async () => {
    const director = chatDirectorWithContinuation("");
    const idle = actionsArray(
      await director.decide(textInferenceDone(10), longState, mockCapabilities),
    );
    expect(idle.some((a) => a.type === "done")).toBe(false);

    const overThreshold = actionsArray(
      await director.decide(
        textInferenceDone(999_999),
        longState,
        mockCapabilities,
      ),
    );
    expect(overThreshold.some((a) => a.type === "done")).toBe(false);
    const afterCompact = actionsArray(
      await director.decide(messageReceived(""), longState, mockCapabilities),
    );
    expect(afterCompact.some((a) => a.type === "done")).toBe(false);
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

  test("reading a code file activates the lsp tool on success", async () => {
    const director = createChatDirector("", [], {});
    await director.decide(
      makeInferenceDoneEvent([
        { id: "c", name: "read_file", args: { path: "src/foo.ts" } },
      ]),
      mockState,
      mockCapabilities,
    );
    const actions = await director.decide(
      makeToolDoneEvent("c"),
      mockState,
      mockCapabilities,
    );
    expect(activateEmits(actions)).toEqual([
      {
        type: "emit",
        eventType: CHAT_TOOLS_ACTIVATE_EVENT,
        data: { names: ["lsp"] },
      },
    ]);
  });

  test("editing a code file activates lsp", async () => {
    const director = createChatDirector("", [], {});
    await director.decide(
      makeInferenceDoneEvent([
        { id: "c", name: "edit_file", args: { path: "lib/bar.rs" } },
      ]),
      mockState,
      mockCapabilities,
    );
    const actions = await director.decide(
      makeToolDoneEvent("c"),
      mockState,
      mockCapabilities,
    );
    expect(activateEmits(actions)).toEqual([
      {
        type: "emit",
        eventType: CHAT_TOOLS_ACTIVATE_EVENT,
        data: { names: ["lsp"] },
      },
    ]);
  });

  test("a non-code file does not activate lsp", async () => {
    const director = createChatDirector("", [], {});
    await director.decide(
      makeInferenceDoneEvent([
        { id: "c", name: "read_file", args: { path: "README.md" } },
      ]),
      mockState,
      mockCapabilities,
    );
    const actions = await director.decide(
      makeToolDoneEvent("c"),
      mockState,
      mockCapabilities,
    );
    expect(activateEmits(actions)).toEqual([]);
  });

  test("a failed read does not activate lsp", async () => {
    const director = createChatDirector("", [], {});
    await director.decide(
      makeInferenceDoneEvent([
        { id: "c", name: "read_file", args: { path: "src/foo.ts" } },
      ]),
      mockState,
      mockCapabilities,
    );
    const actions = await director.decide(
      makeToolErrorEvent("c", "Error: not found"),
      mockState,
      mockCapabilities,
    );
    expect(activateEmits(actions)).toEqual([]);
  });
});

describe("updateToolDefinitions rewrites infer tools", () => {
  const makeMessageReceivedEvent = (content: string) =>
    ({
      type: "message.received",
      message: { role: "user", content },
    }) as unknown as ReactorInboundEvent;
  const capabilitiesWithInferArgs: ReactorCapabilities = {
    ...mockCapabilities,
    infer: (opts) =>
      ({ type: "infer", options: opts }) as unknown as ReactorAction,
  };
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
  const firstInferTools = async (
    director: ReturnType<typeof createChatDirector>,
    event: ReactorInboundEvent,
  ): Promise<unknown> => {
    const result = await director.decide(
      event,
      mockState,
      capabilitiesWithInferArgs,
    );
    const actions = Array.isArray(result) ? result : [result];
    return inferTools(
      actions.find((a) => a.type === "infer") as
        | Record<string, unknown>
        | undefined,
    );
  };

  test("a tool registered after construction is advertised on the next inference", async () => {
    const director = createChatDirector("base-prompt", [], {});
    director.updateToolDefinitions([lateTool]);

    const result = await director.decide(
      makeMessageReceivedEvent("hello"),
      mockState,
      capabilitiesWithInferArgs,
    );
    const actions = Array.isArray(result) ? result : [result];
    const inferAction = actions.find((a) => a.type === "infer") as
      | Record<string, unknown>
      | undefined;
    expect(inferAction).toBeDefined();
    expect(inferToolNames(inferAction)).toContain("mcp__acme__list_issues");
  });

  // The provider cache is a prefix cache keyed on the tools array; a tool_search
  // between turns must not reshape it.
  test("wire tools are byte-identical across a turn that ran tool_search", async () => {
    const director = createChatDirector("base-prompt", [lateTool], {});

    const before = await firstInferTools(
      director,
      makeMessageReceivedEvent("do work"),
    );

    // A full tool_search round-trip: the model calls it, it resolves. Under the
    // stable-superset design this promotes nothing, so the advertised set is
    // untouched.
    await director.decide(
      makeInferenceDoneEvent([
        { id: "ts", name: "tool_search", args: { query: "find files" } },
      ]),
      mockState,
      capabilitiesWithInferArgs,
    );
    await director.decide(
      makeToolDoneEvent("ts"),
      mockState,
      capabilitiesWithInferArgs,
    );

    const after = await firstInferTools(
      director,
      makeMessageReceivedEvent("continue"),
    );
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  // CL-7868 (direction A): the provider cache is a prefix cache keyed on the
  // tools array, so a tool_search turn that promotes a genuinely new tool must
  // not reshape the wire set mid-session. The call gate opens (the model
  // invokes the tool from the search result's schema) while the advertised
  // array holds steady; the growth event lands at the next cache-safe
  // boundary (compaction fold), appended after the untouched fixed prefix.
  test("a tool_search turn promoting a genuinely new tool leaves the wire byte-identical until the fold commits it", async () => {
    const linearTool = {
      name: "mcp__linear__list_issues",
      description: "list issues",
      inputSchema: { type: "object", properties: {}, required: [] },
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

    const before = await firstInferTools(
      director,
      makeMessageReceivedEvent("hello"),
    );

    // tool_search matched a genuinely new tool: the runner opens the call
    // gate (activation); the per-turn wire recompute deliberately ignores it.
    expect(advertised.activated.activate(["mcp__linear__list_issues"])).toBe(
      true,
    );
    director.updateToolDefinitions(
      advertised.computeAdvertised(toolset.dynamicRunner.currentDefinitions()),
    );

    // Mid-session the wire is byte-identical — the hot prefix never grows —
    // while the gate is open so the model can invoke the match from the
    // result card's schema.
    const after = await firstInferTools(
      director,
      makeMessageReceivedEvent("continue"),
    );
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(advertised.isAdvertised("mcp__linear__list_issues")).toBe(true);

    // Cache-safe boundary (compaction fold): the pending promotion commits and
    // the next turn declares it after the untouched fixed prefix.
    expect(advertised.flushPromotions()).toBe(true);
    director.updateToolDefinitions(
      advertised.computeAdvertised(toolset.dynamicRunner.currentDefinitions()),
    );
    const folded = await firstInferTools(
      director,
      makeMessageReceivedEvent("after fold"),
    );
    const foldedNames = (folded as { name: string }[]).map((t) => t.name);
    expect(foldedNames).toContain("mcp__linear__list_issues");
    const beforeNames = (before as { name: string }[])
      .map((t) => t.name)
      .filter((n) => n !== "submit_output");
    const foldedPrefix = foldedNames.filter(
      (n) => n !== "submit_output" && n !== "mcp__linear__list_issues",
    );
    expect(foldedPrefix).toEqual(beforeNames);
    expect(foldedNames.indexOf("mcp__linear__list_issues")).toBe(
      beforeNames.length,
    );

    await toolset.dispose();
  });

  // submit_output is always on the wire so a workflow going active never grows
  // the array and busts the provider cache prefix.
  test("submit_output is advertised even with no active workflow", async () => {
    const director = createChatDirector("base-prompt", [], {});
    director.updateToolDefinitions([lateTool]);

    const result = await director.decide(
      makeMessageReceivedEvent("hello"),
      mockState,
      capabilitiesWithInferArgs,
    );
    const actions = Array.isArray(result) ? result : [result];
    const inferAction = actions.find((a) => a.type === "infer") as
      | Record<string, unknown>
      | undefined;
    expect(inferToolNames(inferAction)).toContain("submit_output");
  });

  // End-to-end: tool_search matches an MCP tool; the runner's gate-only promote
  // wiring (mirrored here via createAdvertisedToolset + updateToolDefinitions)
  // keeps it off the wire the next turn — the hot prefix stays byte-identical
  // while the gate lets the model call it from the result card. The fold
  // commits the pending promotion with the tool's full definition, appended
  // after the untouched fixed prefix, and the array then holds steady.
  test("a tool_search match stays off the wire until the fold, then holds stable", async () => {
    const linearTool = {
      name: "mcp__linear__list_issues",
      description: "list issues",
      inputSchema: { type: "object", properties: {}, required: [] },
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
    const computeAdvertised = (
      all: ReturnType<typeof toolset.dynamicRunner.currentDefinitions>,
    ) => advertised.computeAdvertised(all);
    const director = createChatDirector(
      "base-prompt",
      computeAdvertised(toolset.dynamicRunner.currentDefinitions()),
      {},
    );

    // Before discovery: the MCP tool is registered (dispatchable) but not wired.
    const before = await firstInferTools(
      director,
      makeMessageReceivedEvent("hello"),
    );
    const beforeNames = (before as { name: string }[]).map((t) => t.name);
    expect(beforeNames).not.toContain("mcp__linear__list_issues");
    const beforeJson = JSON.stringify(before);

    // Simulate the runner's gate-only promoter plus its boundary wire push:
    // the gate opens but the wire recompute is byte-identical until the fold.
    advertised.activated.activate(["mcp__linear__list_issues"]);
    director.updateToolDefinitions(
      computeAdvertised(toolset.dynamicRunner.currentDefinitions()),
    );

    const gated = await firstInferTools(
      director,
      makeMessageReceivedEvent("continue"),
    );
    expect((gated as { name: string }[]).map((t) => t.name)).not.toContain(
      "mcp__linear__list_issues",
    );
    expect(JSON.stringify(gated)).toBe(beforeJson);

    // Simulate the compaction fold: commit the pending promotion, push the
    // refreshed set, and the tool is declared — appended after the fixed
    // built-in prefix, which survives untouched ahead of it.
    advertised.flushPromotions();
    director.updateToolDefinitions(
      computeAdvertised(toolset.dynamicRunner.currentDefinitions()),
    );

    const after = await firstInferTools(
      director,
      makeMessageReceivedEvent("after fold"),
    );
    const afterTools = after as { name: string }[];
    const afterNames = afterTools.map((t) => t.name);
    expect(afterNames).toContain("mcp__linear__list_issues");
    // submit_output rides along separately (see withCurrentTools), appended
    // after computeAdvertised's result every turn — strip it before comparing
    // the fixed built-in prefix, which must survive untouched ahead of the
    // newly appended MCP tool.
    const beforePrefix = beforeNames.filter((n) => n !== "submit_output");
    const afterPrefix = afterNames.filter(
      (n) => n !== "submit_output" && n !== "mcp__linear__list_issues",
    );
    expect(afterPrefix).toEqual(beforePrefix);
    expect(afterNames.indexOf("mcp__linear__list_issues")).toBe(
      beforePrefix.length,
    );

    // A further turn with no new discovery stays byte-identical to `after`.
    const stable = await firstInferTools(
      director,
      makeMessageReceivedEvent("keep going"),
    );
    expect(JSON.stringify(stable)).toBe(JSON.stringify(after));
    expect(JSON.stringify(after)).not.toBe(beforeJson);

    await toolset.dispose();
  });

  test("the new-task path also carries the current tools", async () => {
    const classifier = async (_msg: string, _meta: SessionMetadata) =>
      ({ kind: "new_task" as const, reason: "pivot" }) as TaskBoundary;
    const director = createChatDirector("base-prompt", [], {
      taskClassifier: classifier,
    });
    director.updateToolDefinitions([lateTool]);

    const result = await director.decide(
      makeMessageReceivedEvent("new thing"),
      mockState,
      capabilitiesWithInferArgs,
    );
    const actions = Array.isArray(result) ? result : [result];
    const inferAction = actions.find((a) => a.type === "infer") as
      | Record<string, unknown>
      | undefined;
    expect(inferAction).toBeDefined();
    expect(inferToolNames(inferAction)).toContain("mcp__acme__list_issues");
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
    const { WorkflowRuntime } = await import("./workflows/runtime.js");
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
  const manageTasksEvent = (status: "todo" | "doing") =>
    makeInferenceDoneEvent([
      {
        id: "mt",
        name: "manage_tasks",
        args: { action: "create", tasks: [{ id: "t1", title: "x", status }] },
      },
    ]);

  const textTurn = () =>
    ({
      type: "inference.done",
      turn: {
        role: "assistant",
        model: "test",
        timestamp: 0,
        content: [{ type: "text", text: "done" }],
      },
      usage: { input: 0, output: 0 },
      source: "test",
    }) as unknown as ReactorInboundEvent;

  test("open-task nudge uses ephemeralTurns and keeps the stable system prompt", async () => {
    const director = createChatDirector("stable-base", [], {});
    await director.decide(
      manageTasksEvent("doing"),
      mockState,
      mockCapabilities,
    );
    const actions = actionsArray(
      await director.decide(textTurn(), mockState, mockCapabilities),
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
    expect(nudgeText?.type === "text" ? nudgeText.text : "").toContain(
      "tasks are still open",
    );
    expect(options?.systemPrompt).toBe("stable-base");
  });
});

describe("chatDirector spacer echo", () => {
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

  function messageReceived(content: string): ReactorInboundEvent {
    return {
      type: "message.received",
      message: { role: "user", content },
    } as unknown as ReactorInboundEvent;
  }

  test("spacer-only assistant reply is not a finished turn", async () => {
    for (const text of [LEGACY_COMPACT_SPACER_TEXT, COMPACT_SPACER_TEXT]) {
      const director = createChatDirector("base", [], {});
      const actions = actionsArray(
        await director.decide(
          spacerInferenceDone(text),
          mockState,
          mockCapabilities,
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
    let continuations = 0;
    const director = createChatDirector("base", [], {
      requestContinuation: () => {
        continuations++;
      },
    });
    for (let i = 0; i < 2; i++) {
      const nudged = actionsArray(
        await director.decide(
          spacerInferenceDone(LEGACY_COMPACT_SPACER_TEXT),
          longState,
          mockCapabilities,
        ),
      );
      expect(nudged.some((a) => a.type === "infer")).toBe(true);
      expect(continuations).toBe(0);
    }
    const settled = actionsArray(
      await director.decide(
        spacerInferenceDone(COMPACT_SPACER_TEXT),
        longState,
        mockCapabilities,
      ),
    );
    expect(settled.some((a) => a.type === "infer")).toBe(false);
    expect(
      settled.some(
        (a) => a.type === "reply" && "content" in a && a.content === "",
      ),
    ).toBe(true);
    expect(continuations).toBe(0);
  });

  test("echo-nudge cap is two then empty settle, and resets on message.received", async () => {
    const director = createChatDirector("base", [], {});
    for (let i = 0; i < 2; i++) {
      const nudged = actionsArray(
        await director.decide(
          spacerInferenceDone(LEGACY_COMPACT_SPACER_TEXT),
          mockState,
          mockCapabilities,
        ),
      );
      expect(nudged.some((a) => a.type === "infer")).toBe(true);
      expect(nudged.some((a) => a.type === "reply")).toBe(false);
    }
    const exhausted = actionsArray(
      await director.decide(
        spacerInferenceDone(COMPACT_SPACER_TEXT),
        mockState,
        mockCapabilities,
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
      mockState,
      mockCapabilities,
    );
    const afterReset = actionsArray(
      await director.decide(
        spacerInferenceDone(LEGACY_COMPACT_SPACER_TEXT),
        mockState,
        mockCapabilities,
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
      mockState,
      mockCapabilities,
    );
    for (let i = 0; i < 2; i++) {
      const nudged = actionsArray(
        await director.decide(
          spacerInferenceDone(LEGACY_COMPACT_SPACER_TEXT),
          mockState,
          mockCapabilities,
        ),
      );
      expect(nudged.some((a) => a.type === "infer")).toBe(true);
    }
    const afterCap = actionsArray(
      await director.decide(
        spacerInferenceDone(COMPACT_SPACER_TEXT),
        mockState,
        mockCapabilities,
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
          mockState,
          mockCapabilities,
        ),
      );
      expect(nudged.some((a) => a.type === "infer")).toBe(true);
    }
    const exhausted = actionsArray(
      await director.decide(
        spacerInferenceDone(COMPACT_SPACER_TEXT),
        mockState,
        mockCapabilities,
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
      await director.decide(event, mockState, mockCapabilities),
    );
    const infer = actions.find((a) => a.type === "infer") as
      | { options?: ExtendedInferenceOptions }
      | undefined;
    return infer?.options?.systemPrompt;
  }

  test("a Muse Spark session sends the rules, not just the base prompt", async () => {
    const prompt = await promptSentFor("muse-spark-1.3-contributor");
    expect(prompt).toContain("BASE PROMPT");
    expect(prompt).toContain("Batch independent tool calls");
    expect(prompt).toContain("Never re-read a file");
  });

  test("the rules ride at the tail, where they cannot disturb the cache prefix", async () => {
    const prompt = await promptSentFor("muse-spark-1.3-contributor");
    expect(prompt?.startsWith("BASE PROMPT")).toBe(true);
  });

  test("a family with no rules sends the prompt untouched", async () => {
    expect(await promptSentFor("claude-sonnet-4")).toBe("BASE PROMPT");
  });
});
