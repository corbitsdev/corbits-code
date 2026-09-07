import { describe, expect, test } from "bun:test";

import type { SendResult } from "@intx/agent";
import type { ConversationTurn } from "@intx/types/runtime";

import type { PermissionGate } from "../../src/permission/gate.js";
import { createApprovalResume } from "../../src/session/approval-resume.js";

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
  });

  test("an approval timeout from before the suspension does not suppress delivery", async () => {
    const turns = [userTurn(), approvalTimedOutTurn()];
    const { agent, gate, delivered } = harness(turns, false);
    const resume = createApprovalResume({ getAgent: () => agent, gate });

    expect(await resume.handle(SUSPENDED)).toBe(true);
    expect(delivered).toHaveLength(1);
  });
});
