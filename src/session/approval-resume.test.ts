import { describe, expect, mock, test } from "bun:test";
import type { Agent, SendResult } from "@intx/agent";
import type {
  ApprovalSnapshot,
  ContextStore,
  PendingOperation,
  ConversationTurn,
  InboundMessage,
} from "@intx/types/runtime";

import { APPROVAL_TIMEOUT_RESULT_TEXT } from "../permission/decline-markers.js";
import type { PermissionGate } from "../permission/gate.js";
import {
  APPROVAL_DROPPED_NOTICE,
  createApprovalResume,
  resolveParkedCallIdFromStore,
} from "./approval-resume.js";

function assistantTurn(
  calls: { id: string; name: string; command: string }[],
): ConversationTurn {
  return {
    role: "assistant",
    content: calls.map((call) => ({
      type: "tool_call" as const,
      id: call.id,
      name: call.name,
      arguments: { command: call.command },
    })),
    timestamp: 1,
  };
}

function timeoutTurn(callId: string): ConversationTurn {
  return {
    role: "user",
    content: [
      {
        type: "tool_result" as const,
        callId,
        content: [
          { type: "text" as const, text: APPROVAL_TIMEOUT_RESULT_TEXT },
        ],
        isError: true,
      },
    ],
    timestamp: 2,
  };
}

function suspension(
  correlationId: string,
  command: string,
): Extract<SendResult, { type: "suspended" }> {
  const snapshot: ApprovalSnapshot = {
    name: "run_shell",
    description: "run a shell command",
    inputSchema: {},
    arguments: { command },
  };
  return { type: "suspended", correlationId, approvalSnapshot: snapshot };
}

function setup(args: {
  preTurns: ConversationTurn[];
  onGate: (turns: ConversationTurn[]) => void;
  resolveParkedCallId?: (correlationId: string) => string | undefined;
}) {
  const turns: ConversationTurn[] = [...args.preTurns];
  const delivered: InboundMessage[] = [];
  const agent = {
    history: async () => turns,
    deliver: (message: InboundMessage) => {
      delivered.push(message);
    },
  };
  const gate = {
    resolveSuspended: async () => {
      args.onGate(turns);
      return { allow: true };
    },
  } as unknown as PermissionGate;
  const resume = createApprovalResume({
    getAgent: () => agent as Pick<Agent, "deliver" | "history">,
    gate,
    resolveParkedCallId:
      args.resolveParkedCallId ??
      ((correlationId) => (correlationId === "corr-A" ? "call-A" : undefined)),
  });
  return { resume, delivered };
}

function decisionBody(message: InboundMessage): {
  outcome: string;
  message?: string;
} {
  if (message.content === undefined)
    throw new Error("expected a decision body");
  return JSON.parse(message.content) as { outcome: string; message?: string };
}

function deliveredCorrelationId(message: InboundMessage): string {
  const correlationId = message.headers.interchangeCorrelationId;
  if (correlationId === undefined)
    throw new Error("expected an interchange correlation id");
  return correlationId;
}

describe("approval-resume parallel-parked approvals", () => {
  test("delivers A's decision when a different parked call's approval times out", async () => {
    const { resume, delivered } = setup({
      preTurns: [
        assistantTurn([
          { id: "call-A", name: "run_shell", command: "echo alpha" },
          { id: "call-B", name: "run_shell", command: "echo bravo" },
        ]),
      ],
      onGate: (turns) => {
        turns.push(timeoutTurn("call-B"));
      },
    });

    const handled = await resume.handle(suspension("corr-A", "echo alpha"));

    expect(handled).toBe(true);
    expect(delivered).toHaveLength(1);
    const message = delivered[0];
    if (message === undefined) throw new Error("expected a delivered decision");
    expect(deliveredCorrelationId(message)).toBe("corr-A");
    expect(decisionBody(message).outcome).toBe("approved");
  });

  test("still drops a genuinely late decision for the same parked call", async () => {
    const { resume, delivered } = setup({
      preTurns: [
        assistantTurn([
          { id: "call-A", name: "run_shell", command: "echo alpha" },
          { id: "call-B", name: "run_shell", command: "echo bravo" },
        ]),
      ],
      onGate: (turns) => {
        turns.push(timeoutTurn("call-A"));
      },
    });

    const handled = await resume.handle(suspension("corr-A", "echo alpha"));

    expect(handled).toBe(true);
    expect(delivered).toHaveLength(0);
  });

  test("pending-operation lookup identifies the parked call without history tool calls", async () => {
    const { resume, delivered } = setup({
      preTurns: [
        {
          role: "user",
          content: [{ type: "text" as const, text: "run two shell commands" }],
          timestamp: 1,
        },
      ],
      onGate: (turns) => {
        turns.push(timeoutTurn("call-B"));
      },
      resolveParkedCallId: (correlationId) =>
        correlationId === "corr-A" ? "call-A" : undefined,
    });

    const handled = await resume.handle(suspension("corr-A", "echo alpha"));

    expect(handled).toBe(true);
    expect(delivered).toHaveLength(1);
    const message = delivered[0];
    if (message === undefined) throw new Error("expected a delivered decision");
    expect(deliveredCorrelationId(message)).toBe("corr-A");
    expect(decisionBody(message).outcome).toBe("approved");
  });

  test("identical name+args twin: sibling timeout still delivers", async () => {
    const { resume, delivered } = setup({
      preTurns: [
        assistantTurn([
          { id: "call-A", name: "run_shell", command: "echo same" },
          { id: "call-B", name: "run_shell", command: "echo same" },
        ]),
      ],
      onGate: (turns) => {
        turns.push(timeoutTurn("call-B"));
      },
    });

    const handled = await resume.handle(suspension("corr-A", "echo same"));

    expect(handled).toBe(true);
    expect(delivered).toHaveLength(1);
  });

  test("identical name+args twin: own timeout with unanswered twin drops", async () => {
    const pending = new Map([
      ["corr-A", "call-A"],
      ["corr-B", "call-B"],
    ]);
    const { resume, delivered } = setup({
      resolveParkedCallId: (correlationId) => pending.get(correlationId),
      preTurns: [
        assistantTurn([
          { id: "call-A", name: "run_shell", command: "echo same" },
          { id: "call-B", name: "run_shell", command: "echo same" },
        ]),
      ],
      onGate: (turns) => {
        pending.delete("corr-A");
        turns.push(timeoutTurn("call-A"));
      },
    });

    const handled = await resume.handle(suspension("corr-A", "echo same"));

    expect(handled).toBe(true);
    expect(delivered).toHaveLength(0);
    expect(await resume.handle(suspension("corr-B", "echo same"))).toBe(true);
    expect(delivered).toHaveLength(1);
    const message = delivered[0];
    if (message === undefined) throw new Error("expected B decision");
    expect(deliveredCorrelationId(message)).toBe("corr-B");
  });
});

function storeWith(
  pendingOperations: PendingOperation[],
): Pick<ContextStore, "load"> {
  return {
    load: async () => ({
      turns: [],
      pendingOperations,
      tokenUsage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      },
      connectorState: null,
    }),
  };
}

const operation: PendingOperation = {
  correlationId: "corr-A",
  kind: "approval",
  registeredAt: 1,
  gateId: "gate-A",
  suspendedCall: {
    id: "call-A",
    name: "run_shell",
    arguments: { command: "echo same" },
  },
};

describe("persisted approval identity", () => {
  test("requires exactly one matching approval with a suspended call", async () => {
    expect(
      await resolveParkedCallIdFromStore(storeWith([operation]), "corr-A"),
    ).toBe("call-A");
    expect(
      await resolveParkedCallIdFromStore(storeWith([operation]), "corr-B"),
    ).toBeUndefined();
    expect(
      await resolveParkedCallIdFromStore(storeWith([]), "corr-A"),
    ).toBeUndefined();
    expect(
      await resolveParkedCallIdFromStore(
        storeWith([operation, operation]),
        "corr-A",
      ),
    ).toBeUndefined();
    const { suspendedCall: _call, ...withoutCall } = operation;
    expect(
      await resolveParkedCallIdFromStore(storeWith([withoutCall]), "corr-A"),
    ).toBeUndefined();
    expect(
      await resolveParkedCallIdFromStore(
        storeWith([operation, withoutCall]),
        "corr-A",
      ),
    ).toBeUndefined();
  });
});

test("missing or ambiguous stored identity never falls back to an identical history call", async () => {
  for (const pending of [[], [operation, operation]]) {
    const deliver = mock((_message: InboundMessage): void => undefined);
    const resolveSuspended = mock(async () => ({ allow: true }));
    const resume = createApprovalResume({
      getAgent: () => ({
        deliver,
        history: async () => [
          assistantTurn([
            { id: "call-B", name: "run_shell", command: "echo same" },
          ]),
        ],
      }),
      resolveParkedCallId: (id) =>
        resolveParkedCallIdFromStore(storeWith(pending), id),
      gate: { resolveSuspended } as unknown as PermissionGate,
    });
    expect(await resume.handle(suspension("corr-A", "echo same"))).toBe(true);
    expect(resolveSuspended).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  }
});

function deferredResume() {
  const lookup = Promise.withResolvers<string | undefined>();
  const deliver = mock((_message: InboundMessage): void => undefined);
  const history = mock(async (): Promise<ConversationTurn[]> => []);
  const resolveSuspended = mock(async () => ({ allow: true }));
  const resolveParkedCallId = mock(() => lookup.promise);
  const onDropped = mock((_text: string): void => undefined);
  let cancel: (() => void) | undefined;
  let current = true;
  const resume = createApprovalResume({
    getAgent: () => ({ deliver, history }),
    resolveParkedCallId,
    gate: { resolveSuspended } as unknown as PermissionGate,
    captureGeneration: () => () => current,
    onDropped,
    registerParkedCancel: (registered) => {
      cancel = registered;
    },
  });
  return {
    lookup,
    deliver,
    onDropped,
    history,
    resolveSuspended,
    resolveParkedCallId,
    resume,
    cancel: () => cancel?.(),
    registered: () => cancel,
    invalidate: () => {
      current = false;
    },
  };
}

describe("approval identity ordering", () => {
  test("resolves once before opening the gate", async () => {
    const ctx = deferredResume();
    const handling = ctx.resume.handle(suspension("corr-A", "echo same"));
    expect(ctx.resolveSuspended).not.toHaveBeenCalled();
    expect(ctx.history).not.toHaveBeenCalled();
    ctx.lookup.resolve("call-A");
    expect(await handling).toBe(true);
    expect(ctx.resolveParkedCallId).toHaveBeenCalledTimes(1);
    expect(ctx.resolveSuspended).toHaveBeenCalledTimes(1);
    expect(ctx.deliver).toHaveBeenCalledTimes(1);
    expect(ctx.registered()).toBeUndefined();
  });

  for (const cancel of [true, false]) {
    test(`${cancel ? "registered cancellation" : "generation change"} during lookup never delivers or opens gate`, async () => {
      const ctx = deferredResume();
      const handling = ctx.resume.handle(suspension("corr-A", "echo same"));
      expect(ctx.registered()).toBeDefined();
      if (cancel) ctx.cancel();
      else ctx.invalidate();
      expect(ctx.deliver).not.toHaveBeenCalled();
      ctx.lookup.resolve("call-A");
      expect(await handling).toBe(true);
      expect(ctx.deliver).not.toHaveBeenCalled();
      expect(ctx.resolveSuspended).not.toHaveBeenCalled();
      expect(ctx.registered()).toBeUndefined();
    });
  }

  test("generation change during initial history never delivers", async () => {
    const ctx = deferredResume();
    ctx.history.mockImplementation(async () => {
      ctx.invalidate();
      return [];
    });
    const handling = ctx.resume.handle(suspension("corr-A", "echo same"));
    ctx.lookup.resolve("call-A");
    expect(await handling).toBe(true);
    expect(ctx.resolveSuspended).not.toHaveBeenCalled();
    expect(ctx.deliver).not.toHaveBeenCalled();
  });

  test("generation change during post-gate history cannot deliver an approval", async () => {
    const ctx = deferredResume();
    ctx.history.mockResolvedValueOnce([]).mockImplementationOnce(async () => {
      ctx.invalidate();
      return [];
    });
    const handling = ctx.resume.handle(suspension("corr-A", "echo same"));
    ctx.lookup.resolve("call-A");
    expect(await handling).toBe(true);
    expect(ctx.deliver).toHaveBeenCalledTimes(1);
    const message = ctx.deliver.mock.calls[0]?.[0];
    if (message === undefined)
      throw new Error("expected cancellation rejection");
    expect(decisionBody(message).outcome).toBe("rejected");
  });

  for (const timedOutCallId of ["call-A", "call-B"]) {
    test(`generation change during post-gate history with ${timedOutCallId} timeout preserves exact-call cancellation`, async () => {
      const ctx = deferredResume();
      const reading = Promise.withResolvers<undefined>();
      const history = Promise.withResolvers<ConversationTurn[]>();
      ctx.history.mockResolvedValueOnce([]).mockImplementationOnce(() => {
        reading.resolve(undefined);
        return history.promise;
      });
      const handling = ctx.resume.handle(suspension("corr-A", "echo same"));
      ctx.lookup.resolve("call-A");
      await reading.promise;
      expect(ctx.resolveSuspended).toHaveBeenCalledTimes(1);
      expect(ctx.registered()).toBeUndefined();
      ctx.invalidate();
      history.resolve([timeoutTurn(timedOutCallId)]);
      expect(await handling).toBe(true);
      expect(ctx.onDropped).toHaveBeenCalledTimes(1);
      expect(ctx.onDropped).toHaveBeenCalledWith(APPROVAL_DROPPED_NOTICE);
      expect(ctx.registered()).toBeUndefined();
      if (timedOutCallId === "call-A") {
        expect(ctx.deliver).not.toHaveBeenCalled();
      } else {
        expect(ctx.deliver).toHaveBeenCalledTimes(1);
        const message = ctx.deliver.mock.calls[0]?.[0];
        if (message === undefined)
          throw new Error("expected live-call cancellation rejection");
        expect(deliveredCorrelationId(message)).toBe("corr-A");
        expect(decisionBody(message)).toEqual({
          outcome: "rejected",
          message: APPROVAL_DROPPED_NOTICE,
        });
      }
    });
  }

  test("uses the captured agent for both history reads and direct delivery", async () => {
    const agent = {
      deliver: mock((_message: InboundMessage): void => undefined),
      history: mock(async () => []),
    };
    const other = {
      deliver: mock((_message: InboundMessage): void => undefined),
      history: mock(async () => []),
    };
    const getAgent = mock(() => agent)
      .mockReturnValueOnce(agent)
      .mockReturnValue(other);
    const resume = createApprovalResume({
      getAgent,
      resolveParkedCallId: () => "call-A",
      gate: {
        resolveSuspended: async () => ({ allow: true }),
      } as unknown as PermissionGate,
    });
    expect(await resume.handle(suspension("corr-A", "echo same"))).toBe(true);
    expect(getAgent).toHaveBeenCalledTimes(1);
    expect(agent.history).toHaveBeenCalledTimes(2);
    expect(agent.deliver).toHaveBeenCalledTimes(1);
    expect(other.history).not.toHaveBeenCalled();
    expect(other.deliver).not.toHaveBeenCalled();
  });

  test("does not claim atomic expiry detection before a timeout result is observed", async () => {
    const pending = new Map([["corr-A", "call-A"]]);
    const { resume, delivered } = setup({
      preTurns: [],
      resolveParkedCallId: (id) => pending.get(id),
      onGate: () => {
        pending.clear();
      },
    });
    // Reactor correlation removal precedes queued timeout publication. History
    // alone cannot close this interval; atomic admission belongs to the reactor.
    expect(await resume.handle(suspension("corr-A", "echo same"))).toBe(true);
    expect(delivered).toHaveLength(1);
  });

  test("load errors propagate and clear registration without rejection delivery", async () => {
    const ctx = deferredResume();
    const error = new Error("store unavailable");
    const handling = ctx.resume.handle(suspension("corr-A", "echo same"));
    ctx.lookup.reject(error);
    await expect(handling).rejects.toBe(error);
    expect(ctx.registered()).toBeUndefined();
    expect(ctx.deliver).not.toHaveBeenCalled();
    expect(ctx.resolveSuspended).not.toHaveBeenCalled();
    await expect(
      resolveParkedCallIdFromStore(
        {
          load: async () => {
            throw error;
          },
        },
        "corr-A",
      ),
    ).rejects.toBe(error);
  });

  for (const snapshot of [
    undefined,
    { name: 42 },
    { name: "run_shell", arguments: { command: 42 } },
  ]) {
    for (const identity of ["missing", "expired", "live"] as const) {
      test(`invalid snapshot ${JSON.stringify(snapshot)} with ${identity} identity`, async () => {
        const ctx = deferredResume();
        if (identity === "expired")
          ctx.history.mockResolvedValue([timeoutTurn("call-A")]);
        const result = {
          type: "suspended",
          correlationId: "corr-A",
          approvalSnapshot: snapshot,
        } as unknown as SendResult;
        const handling = ctx.resume.handle(result);
        ctx.lookup.resolve(identity === "missing" ? undefined : "call-A");
        expect(await handling).toBe(true);
        expect(ctx.resolveSuspended).not.toHaveBeenCalled();
        expect(ctx.deliver).toHaveBeenCalledTimes(identity === "live" ? 1 : 0);
        if (identity === "live") {
          const message = ctx.deliver.mock.calls[0]?.[0];
          if (message === undefined) throw new Error("expected rejection");
          expect(decisionBody(message).outcome).toBe("rejected");
        }
      });
    }
  }

  test("observed exact timeout during lookup prevents the gate and delivery", async () => {
    const ctx = deferredResume();
    const handling = ctx.resume.handle(suspension("corr-A", "echo same"));
    ctx.history.mockResolvedValue([timeoutTurn("call-A")]);
    ctx.lookup.resolve("call-A");
    expect(await handling).toBe(true);
    expect(ctx.resolveSuspended).not.toHaveBeenCalled();
    expect(ctx.deliver).not.toHaveBeenCalled();
  });
});
