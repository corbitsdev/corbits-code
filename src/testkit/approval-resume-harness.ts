/**
 * Shared fixtures for approval-resume tests: a fake agent/gate pair wired the
 * way `createApprovalResume` consumes them, the suspended SendResult they
 * resume, and the tool-call / approval-timeout turns planted in history.
 */
import type { Agent, SendResult } from "@intx/agent";
import type {
  ApprovalSnapshot,
  ConversationTurn,
  InboundMessage,
} from "@intx/types/runtime";

import { APPROVAL_TIMEOUT_RESULT_TEXT } from "../permission/decline-markers.js";
import type { PermissionGate } from "../permission/gate.js";

export function shellApprovalSnapshot(command: string): ApprovalSnapshot {
  return {
    name: "run_shell",
    description: "run a shell command",
    inputSchema: {},
    arguments: { command },
  };
}

export function suspendedResult(
  correlationId: string,
  command: string,
): Extract<SendResult, { type: "suspended" }> {
  return {
    type: "suspended",
    correlationId,
    approvalSnapshot: shellApprovalSnapshot(command),
  };
}

export function assistantToolCallTurn(
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

export function approvalTimeoutTurn(callId: string): ConversationTurn {
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

export function userTextTurn(text: string): ConversationTurn {
  return {
    role: "user",
    content: [{ type: "text" as const, text }],
    timestamp: 1,
  } as unknown as ConversationTurn;
}

export interface ApprovalResumeHarness {
  turns: ConversationTurn[];
  agent: Pick<Agent, "deliver" | "history">;
  gate: PermissionGate;
  delivered: InboundMessage[];
}

/**
 * Fake agent/gate scaffolding: history reads the live `turns` array (tests
 * mutate it from `onGate` to simulate state landing between lookup and
 * resolve), delivery is recorded in `delivered`.
 */
export function createApprovalResumeHarness(args: {
  turns?: ConversationTurn[];
  onGate?: (turns: ConversationTurn[]) => void;
  gateOutcome?: { allow: boolean; message?: string };
} = {}): ApprovalResumeHarness {
  const turns = [...(args.turns ?? [])];
  const delivered: InboundMessage[] = [];
  const agent = {
    history: async () => turns,
    deliver: (message: InboundMessage) => {
      delivered.push(message);
    },
  };
  const gate = {
    resolveSuspended: async () => {
      args.onGate?.(turns);
      return args.gateOutcome ?? { allow: true };
    },
  } as unknown as PermissionGate;
  return { turns, agent, gate, delivered };
}

export function decisionBody(message: InboundMessage): {
  outcome: string;
  message?: string;
} {
  if (message.content === undefined)
    throw new Error("expected a decision body");
  return JSON.parse(message.content) as { outcome: string; message?: string };
}

export function firstDelivered(delivered: InboundMessage[]): InboundMessage {
  const message = delivered[0];
  if (message === undefined)
    throw new Error("expected a delivered decision");
  return message;
}

export function deliveredCorrelationId(message: InboundMessage): string {
  const correlationId = message.headers.interchangeCorrelationId;
  if (correlationId === undefined)
    throw new Error("expected an interchange correlation id");
  return correlationId;
}
