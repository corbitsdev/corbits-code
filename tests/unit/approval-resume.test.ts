import { describe, expect, test } from "bun:test";

import { AgentClosedError, type SendResult } from "@intx/agent";
import type { ConversationTurn, InboundMessage } from "@intx/types/runtime";

import type { PermissionGate } from "../../src/permission/gate.js";
import { createApprovalResume } from "../../src/session/approval-resume.js";
import { createDeliveryGeneration } from "../../src/tui/queued-delivery.js";

const SUSPENDED: SendResult = {
  type: "suspended",
  correlationId: "corr-1",
  approvalSnapshot: { name: "run_shell", arguments: { command: "curl -sS https://example.com" } },
} as unknown as SendResult;

function userTurn(): ConversationTurn {
  return {
    role: "user",
    content: [{ type: "text", text: "go" }],
    timestamp: 0,
  } as unknown as ConversationTurn;
}

function approvalTimedOutTurn(): ConversationTurn {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        callId: "call-ask",
        content: [{ type: "text", text: "approval timed out" }],
      },
    ],
    timestamp: 0,
  } as unknown as ConversationTurn;
}

function harness(turns: ConversationTurn[], plantTimeoutOnResolve: boolean) {
  const delivered: unknown[] = [];
  const agent = {
    deliver: (message: unknown) => delivered.push(message),
    history: async () => turns,
  };
  const gate = {
    resolveSuspended: async () => {
      if (plantTimeoutOnResolve) turns.push(approvalTimedOutTurn());
      return { allow: false, message: "not today" };
    },
  } as unknown as PermissionGate;
  return { agent, gate, delivered };
}

function correlationHeaders(message: unknown) {
  return (message as InboundMessage).headers;
}

describe("approval resume late-decision guard", () => {
  test("a decision after the reactor settled the correlation is dropped", async () => {
    const turns = [userTurn()];
    const { agent, gate, delivered } = harness(turns, true);
    const resume = createApprovalResume({ getAgent: () => agent, gate });

    expect(await resume.handle(SUSPENDED)).toBe(true);
    expect(delivered).toEqual([]);
  });

  test("a live decision is still delivered", async () => {
    const turns = [userTurn()];
    const { agent, gate, delivered } = harness(turns, false);
    const resume = createApprovalResume({ getAgent: () => agent, gate });

    expect(await resume.handle(SUSPENDED)).toBe(true);
    expect(delivered).toHaveLength(1);
    const message = delivered[0] as { content: string };
    expect(JSON.parse(message.content)).toEqual({ outcome: "rejected", message: "not today" });
    expect(correlationHeaders(delivered[0]).interchangeCorrelationId).toBe("corr-1");
    expect(correlationHeaders(delivered[0]).messageId).toBe("approval-corr-1");
  });

  test("an approval timeout from before the suspension does not suppress delivery", async () => {
    const turns = [userTurn(), approvalTimedOutTurn()];
    const { agent, gate, delivered } = harness(turns, false);
    const resume = createApprovalResume({ getAgent: () => agent, gate });

    expect(await resume.handle(SUSPENDED)).toBe(true);
    expect(delivered).toHaveLength(1);
  });
});

describe("approval resume late-bind", () => {
  test("rebuild-during-wait delivers to the agent present after resolveSuspended", async () => {
    const deliveredA: unknown[] = [];
    const deliveredB: unknown[] = [];
    const agentA = {
      deliver: (message: unknown) => deliveredA.push(message),
      history: async () => [userTurn()],
    };
    const agentB = {
      deliver: (message: unknown) => deliveredB.push(message),
      history: async () => [userTurn()],
    };
    let current: typeof agentA | typeof agentB = agentA;
    const gate = {
      resolveSuspended: async () => {
        current = agentB;
        return { allow: true };
      },
    } as unknown as PermissionGate;
    const resume = createApprovalResume({ getAgent: () => current, gate });

    expect(await resume.handle(SUSPENDED)).toBe(true);
    expect(deliveredA).toEqual([]);
    expect(deliveredB).toHaveLength(1);
    expect(correlationHeaders(deliveredB[0]).interchangeCorrelationId).toBe("corr-1");
    expect(correlationHeaders(deliveredB[0]).messageId).toBe("approval-corr-1");
  });

  test("optional deliver is awaited and used instead of getAgent().deliver", async () => {
    const agentDelivered: unknown[] = [];
    const customDelivered: unknown[] = [];
    const agent = {
      deliver: (message: unknown) => agentDelivered.push(message),
      history: async () => [userTurn()],
    };
    let customResolved = false;
    const resume = createApprovalResume({
      getAgent: () => agent,
      deliver: async (message) => {
        await Promise.resolve();
        customResolved = true;
        customDelivered.push(message);
      },
      gate: { resolveSuspended: async () => ({ allow: true }) } as unknown as PermissionGate,
    });

    expect(await resume.handle(SUSPENDED)).toBe(true);
    expect(customResolved).toBe(true);
    expect(agentDelivered).toEqual([]);
    expect(customDelivered).toHaveLength(1);
    expect(correlationHeaders(customDelivered[0]).interchangeCorrelationId).toBe("corr-1");
  });

  test("undefined agent throws instead of returning true", async () => {
    const resume = createApprovalResume({
      getAgent: () => undefined,
      gate: { resolveSuspended: async () => ({ allow: true }) } as unknown as PermissionGate,
    });
    await expect(resume.handle(SUSPENDED)).rejects.toThrow(/agent/i);
  });

  test("AgentClosedError from deliver is not swallowed", async () => {
    const agent = {
      deliver: () => {
        throw new AgentClosedError();
      },
      history: async () => [userTurn()],
    };
    const resume = createApprovalResume({
      getAgent: () => agent,
      gate: { resolveSuspended: async () => ({ allow: true }) } as unknown as PermissionGate,
    });
    await expect(resume.handle(SUSPENDED)).rejects.toThrow(AgentClosedError);
  });

  test("an intervening user turn after suspend does not drop a live decision", async () => {
    const turns = [userTurn()];
    const delivered: unknown[] = [];
    const agent = {
      deliver: (message: unknown) => delivered.push(message),
      history: async () => turns,
    };
    const gate = {
      resolveSuspended: async () => {
        turns.push(userTurn());
        return { allow: true };
      },
    } as unknown as PermissionGate;
    const resume = createApprovalResume({ getAgent: () => agent, gate });

    expect(await resume.handle(SUSPENDED)).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(JSON.parse((delivered[0] as { content: string }).content)).toEqual({
      outcome: "approved",
    });
    expect(correlationHeaders(delivered[0]).interchangeCorrelationId).toBe("corr-1");
  });
});

describe("approval resume generation capture", () => {
  test("overlay accept after a generation bump does not deliver", async () => {
    const generation = createDeliveryGeneration();
    const delivered: unknown[] = [];
    const agent = {
      deliver: (message: unknown) => delivered.push(message),
      history: async () => [userTurn()],
    };
    const resume = createApprovalResume({
      getAgent: () => agent,
      captureGeneration: generation.capture,
      deliver: (message, stillCurrent) => {
        if (!stillCurrent()) return;
        delivered.push(message);
      },
      gate: {
        resolveSuspended: async () => {
          generation.bump();
          return { allow: true };
        },
      } as unknown as PermissionGate,
    });

    expect(await resume.handle(SUSPENDED)).toBe(true);
    expect(delivered).toEqual([]);
  });

  test("a live generation still delivers after the overlay", async () => {
    const generation = createDeliveryGeneration();
    const delivered: unknown[] = [];
    const agent = {
      deliver: (message: unknown) => delivered.push(message),
      history: async () => [userTurn()],
    };
    const resume = createApprovalResume({
      getAgent: () => agent,
      captureGeneration: generation.capture,
      deliver: (message, stillCurrent) => {
        if (!stillCurrent()) return;
        delivered.push(message);
      },
      gate: { resolveSuspended: async () => ({ allow: true }) } as unknown as PermissionGate,
    });

    expect(await resume.handle(SUSPENDED)).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(JSON.parse((delivered[0] as { content: string }).content)).toEqual({
      outcome: "approved",
    });
  });
});
