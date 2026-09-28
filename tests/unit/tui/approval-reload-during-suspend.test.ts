import { describe, expect, test } from "bun:test";

import type { SendResult } from "@intx/agent";
import type { ConversationTurn } from "@intx/types/runtime";

import type { PermissionGate } from "../../../src/permission/gate.js";
import { createApprovalResume } from "../../../src/session/approval-resume.js";
import { createSessionOperationQueue } from "../../../src/tui/delivery-queue.js";
import {
  runWhileAgentBusy,
  type RunnerState,
} from "../../../src/tui/runner/state.js";

const SUSPENDED: SendResult = {
  type: "suspended",
  correlationId: "corr-1",
  approvalSnapshot: {
    name: "run_shell",
    arguments: { command: "curl -sS https://example.com" },
  },
} as unknown as SendResult;

function userTurn(): ConversationTurn {
  return {
    role: "user",
    content: [{ type: "text", text: "go" }],
    timestamp: 0,
  } as unknown as ConversationTurn;
}

describe("pendingReload during resolveSuspended vs deliver enqueue", () => {
  test("does not rebuild until handle returns and deliver has run", async () => {
    const events: string[] = [];
    const { enqueue, awaitTail } = createSessionOperationQueue();
    const state: Pick<RunnerState, "inFlight" | "reloadIfIdle"> & {
      pendingReload: boolean;
    } = {
      inFlight: 0,
      pendingReload: false,
      reloadIfIdle: () => {
        if (!state.pendingReload || state.inFlight > 0) return;
        state.pendingReload = false;
        void enqueue(async () => {
          events.push("rebuild");
        });
      },
    };
    const agent = {
      deliver: (_message: unknown) => {
        events.push("deliver");
      },
      history: async () => [userTurn()],
    };
    const resume = createApprovalResume({
      getAgent: () => agent,
      resolveParkedCallId: () => "call-ask",
      deliver: (message) =>
        enqueue(async () => {
          agent.deliver(message);
        }),
      gate: {
        resolveSuspended: async () => {
          state.pendingReload = true;
          state.reloadIfIdle?.();
          expect(events).toEqual([]);
          return { allow: true };
        },
      } as unknown as PermissionGate,
    });

    await runWhileAgentBusy(state, async () => {
      await resume.handle(SUSPENDED);
    });
    await awaitTail();

    expect(events).toEqual(["deliver", "rebuild"]);
    expect(state.inFlight).toBe(0);
  });
});
