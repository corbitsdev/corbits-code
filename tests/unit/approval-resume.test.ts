import { describe, expect, test } from "bun:test";

import { AgentClosedError, type SendResult } from "@intx/agent";
import type { ConversationTurn, InboundMessage } from "@intx/types/runtime";

import { createPermissionGate, type PermissionGate } from "../../src/permission/gate.js";
import type { Approval, ApprovalScope, PermissionRequest } from "../../src/permission/types.js";
import {
  APPROVAL_DROPPED_NOTICE,
  createApprovalResume,
} from "../../src/session/approval-resume.js";
import { createCorrelationAcceptance } from "../../src/tui/correlation-acceptance.js";
import type { PermissionGateEvent } from "../../src/tui/gate-events.js";
import {
  createDeliveryGeneration,
  SESSION_IDENTITY_ABORT_REASON,
} from "../../src/tui/queued-delivery.js";
import { createGateRequestApproval } from "../../src/tui/request-approval.js";
import { runWhileAgentBusy } from "../../src/tui/runner/state.js";
import { createSessionOperationQueue } from "../../src/tui/session-operation-queue.js";

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

describe("approval resume delivery", () => {
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

  async function interruptDuringOverlayThenDecide(outcome: { allow: boolean; message?: string }) {
    const generation = createDeliveryGeneration();
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
    const resume = createApprovalResume({
      getAgent: () => current,
      captureGeneration: generation.capture,
      deliver: (message, stillCurrent) => {
        if (!stillCurrent()) return;
        current.deliver(message);
      },
      gate: {
        resolveSuspended: async () => {
          generation.bump();
          current = agentB;
          return outcome;
        },
      } as unknown as PermissionGate,
    });

    expect(await resume.handle(SUSPENDED)).toBe(true);
    expect(deliveredA).toEqual([]);
    expect(deliveredB).toEqual([]);
  }

  test("interrupt during overlay then accept does not deliver to the rebuilt agent", async () => {
    await interruptDuringOverlayThenDecide({ allow: true });
  });

  test("interrupt during overlay then decline does not deliver to the rebuilt agent", async () => {
    await interruptDuringOverlayThenDecide({ allow: false, message: "not today" });
  });
});

const persistAllow: ApprovalScope = {
  id: "project-curl",
  label: "Allow curl *",
  pattern: "curl *",
  grant: "project",
};

function persistRequest(): PermissionRequest {
  return {
    tool: "run_shell",
    action: "Run shell command",
    subject: "curl -sS https://example.com",
    scopes: [persistAllow],
  };
}

describe("approval resume identity abort", () => {
  test("generation bump aborts the merged overlay signal with the identity reason", async () => {
    const generation = createDeliveryGeneration();
    let captured: PermissionGateEvent | undefined;
    const requestApproval = createGateRequestApproval({
      emitGate: (event) => {
        captured = event;
        return true;
      },
      approvalTimeout: () => undefined,
      identitySignal: () => generation.signal(),
    });
    const pending = requestApproval(persistRequest());
    expect(captured?.signal?.aborted).toBe(false);
    generation.bump();
    expect(captured?.signal?.aborted).toBe(true);
    expect(captured?.signal?.reason).toBe(SESSION_IDENTITY_ABORT_REASON);
    captured?.resolve({ allow: false, message: SESSION_IDENTITY_ABORT_REASON });
    await pending;
  });
});

describe("approval resume persist Allow after interrupt", () => {
  test("drops persist Allow: no grant, overlay dismissed, operator notice", async () => {
    const generation = createDeliveryGeneration();
    const persisted: Approval[] = [];
    let overlay: PermissionGateEvent | undefined;
    let overlayReady: (() => void) | undefined;
    const waitForOverlay = new Promise<void>((resolve) => {
      overlayReady = resolve;
    });
    const requestApproval = createGateRequestApproval({
      emitGate: (event) => {
        overlay = event;
        overlayReady?.();
        event.signal?.addEventListener(
          "abort",
          () => {
            overlay = undefined;
            event.resolve({
              allow: false,
              message:
                typeof event.signal?.reason === "string"
                  ? event.signal.reason
                  : SESSION_IDENTITY_ABORT_REASON,
            });
          },
          { once: true },
        );
        return true;
      },
      approvalTimeout: () => undefined,
      identitySignal: () => generation.signal(),
    });
    const gate = createPermissionGate({
      approvals: [],
      interactive: true,
      skipPermissions: false,
      reactorGated: true,
      requestApproval,
      persist: (approval) => {
        persisted.push(approval);
      },
    });
    const delivered: unknown[] = [];
    const notices: string[] = [];
    const resume = createApprovalResume({
      getAgent: () => ({
        deliver: (message: unknown) => delivered.push(message),
        history: async () => [userTurn()],
      }),
      captureGeneration: generation.capture,
      onDropped: (text) => notices.push(text),
      gate,
    });

    const pending = resume.handle(SUSPENDED);
    await waitForOverlay;
    expect(overlay).toBeDefined();

    const dismissed = overlay;
    generation.bump();
    dismissed?.resolve({ allow: true, persist: persistAllow });

    expect(await pending).toBe(true);
    expect(overlay).toBeUndefined();
    expect(persisted).toEqual([]);
    expect(gate.getApprovals()).toEqual([]);
    expect(notices).toEqual([APPROVAL_DROPPED_NOTICE]);
    expect(delivered).toEqual([]);
  });
});

describe("approval resume stillCurrent at resolve", () => {
  test("handle forwards the capture-at-start stillCurrent into resolveSuspended", async () => {
    const generation = createDeliveryGeneration();
    let atResolve: boolean | undefined;
    const resume = createApprovalResume({
      getAgent: () => ({
        deliver: () => undefined,
        history: async () => [userTurn()],
      }),
      captureGeneration: generation.capture,
      gate: {
        resolveSuspended: async (_request: PermissionRequest, stillCurrent?: () => boolean) => {
          expect(stillCurrent?.()).toBe(true);
          generation.bump();
          atResolve = stillCurrent?.();
          return { allow: true, persist: persistAllow };
        },
      } as unknown as PermissionGate,
    });

    expect(await resume.handle(SUSPENDED)).toBe(true);
    expect(atResolve).toBe(false);
  });

  test("resolveSuspended skips mintGrant when stillCurrent is false after persist Allow", async () => {
    const generation = createDeliveryGeneration();
    const stillCurrent = generation.capture();
    const persisted: Approval[] = [];
    const gate = createPermissionGate({
      approvals: [],
      interactive: true,
      skipPermissions: false,
      reactorGated: true,
      persist: (approval) => {
        persisted.push(approval);
      },
      requestApproval: async () => {
        generation.bump();
        return { allow: true, persist: persistAllow };
      },
    });

    const outcome = await gate.resolveSuspended(persistRequest(), stillCurrent);
    expect(outcome?.allow).toBe(true);
    expect(stillCurrent()).toBe(false);
    expect(persisted).toEqual([]);
    expect(gate.getApprovals()).toEqual([]);
  });
});

describe("approval resume occupancy until correlation", () => {
  test("inFlight holds idle rebuild until the correlated resume is accepted", async () => {
    const events: string[] = [];
    const { enqueue, awaitTail } = createSessionOperationQueue();
    const correlationAcceptance = createCorrelationAcceptance();
    let delivered: (() => void) | undefined;
    const waitUntilDelivered = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const state = {
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
      deliver: (message) =>
        enqueue(async () => {
          const correlationId = message.headers.interchangeCorrelationId;
          const accepted =
            correlationId === undefined ? undefined : correlationAcceptance.wait(correlationId);
          agent.deliver(message);
          delivered?.();
          await accepted;
        }),
      gate: {
        resolveSuspended: async () => {
          state.pendingReload = true;
          state.reloadIfIdle?.();
          return { allow: true };
        },
      } as unknown as PermissionGate,
    });

    const running = runWhileAgentBusy(state, async () => {
      await resume.handle(SUSPENDED);
    });

    await waitUntilDelivered;
    expect(events).toEqual(["deliver"]);
    expect(state.inFlight).toBe(1);
    expect(state.pendingReload).toBe(true);

    correlationAcceptance.settle("corr-1");
    await running;
    await awaitTail();

    expect(events).toEqual(["deliver", "rebuild"]);
    expect(state.inFlight).toBe(0);
  });

  test("generation bump settleAll releases occupancy without a correlation event", async () => {
    const correlationAcceptance = createCorrelationAcceptance();
    const generation = createDeliveryGeneration(() => correlationAcceptance.settleAll());
    let waiting: (() => void) | undefined;
    const waitUntilWaiting = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const state = {
      inFlight: 0,
      pendingReload: false,
      reloadIfIdle: () => undefined,
    };
    const resume = createApprovalResume({
      getAgent: () => ({
        deliver: () => undefined,
        history: async () => [userTurn()],
      }),
      captureGeneration: generation.capture,
      deliver: (message) => {
        const correlationId = message.headers.interchangeCorrelationId;
        if (correlationId === undefined) return;
        const accepted = correlationAcceptance.wait(correlationId);
        waiting?.();
        return accepted;
      },
      gate: {
        resolveSuspended: async () => ({ allow: true }),
      } as unknown as PermissionGate,
    });

    const running = runWhileAgentBusy(state, async () => {
      await resume.handle(SUSPENDED);
    });
    await waitUntilWaiting;
    expect(state.inFlight).toBe(1);
    generation.bump();
    await running;
    expect(state.inFlight).toBe(0);
  });
});
