import { describe, expect, test } from "bun:test";

import type { ConversationTurn, InboundMessage } from "@intx/types/runtime";

import { APPROVAL_TIMEOUT_RESULT_TEXT } from "../permission/decline-markers.js";
import {
  createPermissionGate,
  type PermissionGate,
} from "../permission/gate.js";
import type {
  Approval,
  ApprovalScope,
  PermissionRequest,
} from "../permission/types.js";
import {
  APPROVAL_DROPPED_NOTICE,
  createApprovalResume,
} from "./approval-resume.js";
import { createCorrelationAcceptance } from "../tui/correlation-acceptance.js";
import type { PermissionGateEvent } from "../tui/gate-events.js";
import {
  createDeliveryGeneration,
  createSessionOperationQueue,
  SESSION_IDENTITY_ABORT_REASON,
} from "../tui/delivery-queue.js";
import { createGateRequestApproval } from "../tui/request-approval.js";
import { startInterruptRebuild } from "../tui/runner/exit.js";
import { runWhileAgentBusy } from "../tui/runner/state.js";
import { createParkedOverlayAbortBinding } from "../tui/runner/parked-overlay-abort.js";
import {
  approvalTimeoutTurn,
  createApprovalResumeHarness,
  decisionBody,
  firstDelivered,
  suspendedResult,
  userTextTurn,
} from "../../testkit/approval-resume-harness.js";

const SUSPENDED = suspendedResult("corr-1", "curl -sS https://example.com");

function userTurn(): ConversationTurn {
  return userTextTurn("go");
}

function approvalTimedOutTurn(): ConversationTurn {
  return approvalTimeoutTurn("call-ask");
}

function harness(turns: ConversationTurn[], plantTimeoutOnResolve: boolean) {
  const { agent, gate, delivered } = createApprovalResumeHarness({
    turns,
    gateOutcome: { allow: false, message: "not today" },
    ...(plantTimeoutOnResolve
      ? {
          onGate: (current: ConversationTurn[]) => {
            current.push(approvalTimedOutTurn());
          },
        }
      : {}),
  });
  return { agent, gate, delivered: delivered as unknown[] };
}

function correlationHeaders(message: unknown) {
  return (message as InboundMessage).headers;
}

function firstDeliveredContent(delivered: unknown[]): unknown {
  return decisionBody(firstDelivered(delivered as InboundMessage[]));
}

describe("approval resume late-decision guard", () => {
  test("a decision after the reactor settled the correlation is dropped", async () => {
    const turns = [userTurn()];
    const { agent, gate, delivered } = harness(turns, true);
    const resume = createApprovalResume({
      resolveParkedCallId: () => "call-ask",
      getAgent: () => agent,
      gate,
    });

    expect(await resume.handle(SUSPENDED)).toBe(true);
    expect(delivered).toEqual([]);
  });

  test("a live decision is still delivered", async () => {
    const turns = [userTurn()];
    const { agent, gate, delivered } = harness(turns, false);
    const resume = createApprovalResume({
      resolveParkedCallId: () => "call-ask",
      getAgent: () => agent,
      gate,
    });

    expect(await resume.handle(SUSPENDED)).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(firstDeliveredContent(delivered)).toEqual({
      outcome: "rejected",
      message: "not today",
    });
    expect(correlationHeaders(delivered[0]).interchangeCorrelationId).toBe(
      "corr-1",
    );
    expect(correlationHeaders(delivered[0]).messageId).toBe("approval-corr-1");
  });

  test("an exact approval timeout already present before lookup suppresses delivery", async () => {
    const turns = [userTurn(), approvalTimedOutTurn()];
    const { agent, gate, delivered } = harness(turns, false);
    const resume = createApprovalResume({
      resolveParkedCallId: () => "call-ask",
      getAgent: () => agent,
      gate,
    });

    expect(await resume.handle(SUSPENDED)).toBe(true);
    expect(delivered).toHaveLength(0);
  });
});

describe("approval resume generation capture", () => {
  test("overlay accept after a generation bump rejects the parked call on the old agent", async () => {
    const generation = createDeliveryGeneration();
    const delivered: unknown[] = [];
    const agent = {
      deliver: (message: unknown) => delivered.push(message),
      history: async () => [userTurn()],
    };
    const resume = createApprovalResume({
      resolveParkedCallId: () => "call-ask",
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
    expect(delivered).toHaveLength(1);
    expect(firstDeliveredContent(delivered)).toEqual({
      outcome: "rejected",
      message: APPROVAL_DROPPED_NOTICE,
    });
  });

  test("a live generation still delivers after the overlay", async () => {
    const generation = createDeliveryGeneration();
    const delivered: unknown[] = [];
    const agent = {
      deliver: (message: unknown) => delivered.push(message),
      history: async () => [userTurn()],
    };
    const resume = createApprovalResume({
      resolveParkedCallId: () => "call-ask",
      getAgent: () => agent,
      captureGeneration: generation.capture,
      deliver: (message, stillCurrent) => {
        if (!stillCurrent()) return;
        delivered.push(message);
      },
      gate: {
        resolveSuspended: async () => ({ allow: true }),
      } as unknown as PermissionGate,
    });

    expect(await resume.handle(SUSPENDED)).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(firstDeliveredContent(delivered)).toEqual({
      outcome: "approved",
    });
  });

  async function interruptDuringOverlayThenDecide(outcome: {
    allow: boolean;
    message?: string;
  }) {
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
      resolveParkedCallId: () => "call-ask",
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
    expect(deliveredA).toHaveLength(1);
    expect(firstDeliveredContent(deliveredA)).toEqual({
      outcome: "rejected",
      message: APPROVAL_DROPPED_NOTICE,
    });
    expect(deliveredB).toEqual([]);
  }

  test("interrupt during overlay then accept does not deliver to the rebuilt agent", async () => {
    await interruptDuringOverlayThenDecide({ allow: true });
  });

  test("interrupt during overlay then decline does not deliver to the rebuilt agent", async () => {
    await interruptDuringOverlayThenDecide({
      allow: false,
      message: "not today",
    });
  });

  test("interrupt during overlay rejects the parked call before rebuild enqueue", async () => {
    const events: string[] = [];
    const parkedCancel = { fn: undefined as (() => void) | undefined };
    const generation = createDeliveryGeneration(() => parkedCancel.fn?.());
    const { enqueue, awaitTail } = createSessionOperationQueue();
    const delivered: unknown[] = [];
    const agent = {
      deliver: (message: unknown) => {
        events.push("reject");
        delivered.push(message);
      },
      history: async () => [userTurn()],
    };
    let overlayReady: (() => void) | undefined;
    const waitForOverlay = new Promise<void>((resolve) => {
      overlayReady = resolve;
    });
    let finishOverlay: ((outcome: { allow: boolean }) => void) | undefined;
    const resume = createApprovalResume({
      resolveParkedCallId: () => "call-ask",
      getAgent: () => agent,
      captureGeneration: generation.capture,
      registerParkedCancel: (cancel) => {
        parkedCancel.fn = cancel;
      },
      onDropped: () => events.push("dropped"),
      gate: {
        resolveSuspended: () => {
          overlayReady?.();
          return new Promise((resolve) => {
            finishOverlay = resolve;
          });
        },
      } as unknown as PermissionGate,
    });

    const handling = resume.handle(SUSPENDED);
    await waitForOverlay;
    startInterruptRebuild({
      deliveryGeneration: generation,
      markSendAborted: () => {
        events.push("abort");
      },
      enqueue: (op) => {
        events.push("enqueue");
        return enqueue(op);
      },
      rebuild: async () => {
        events.push("rebuild");
      },
    });
    finishOverlay?.({ allow: false });

    expect(await handling).toBe(true);
    await awaitTail();
    expect(events.indexOf("reject")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("reject")).toBeLessThan(events.indexOf("enqueue"));
    expect(events).toContain("rebuild");
    expect(firstDeliveredContent(delivered)).toEqual({
      outcome: "rejected",
      message: APPROVAL_DROPPED_NOTICE,
    });
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
      resolveParkedCallId: () => "call-ask",
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
    expect(delivered).toHaveLength(1);
    expect(firstDeliveredContent(delivered)).toEqual({
      outcome: "rejected",
      message: APPROVAL_DROPPED_NOTICE,
    });
  });
});

describe("approval resume stillCurrent at resolve", () => {
  test("handle forwards the capture-at-start stillCurrent into resolveSuspended", async () => {
    const generation = createDeliveryGeneration();
    let atResolve: boolean | undefined;
    const resume = createApprovalResume({
      resolveParkedCallId: () => "call-ask",
      getAgent: () => ({
        deliver: () => undefined,
        history: async () => [userTurn()],
      }),
      captureGeneration: generation.capture,
      gate: {
        resolveSuspended: async (
          _request: PermissionRequest,
          stillCurrent?: () => boolean,
        ) => {
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
  // Shared rig: deliver parks on correlation acceptance while rebuild waits
  // for inFlight to drain; `run()` starts the handle.
  function occupancyResume() {
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
      resolveParkedCallId: () => "call-ask",
      getAgent: () => agent,
      deliver: (message) =>
        enqueue(async () => {
          const correlationId = message.headers.interchangeCorrelationId;
          const accepted =
            correlationId === undefined
              ? undefined
              : correlationAcceptance.wait(correlationId);
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
    const run = () =>
      runWhileAgentBusy(state, async () => {
        await resume.handle(SUSPENDED);
      });
    return {
      events,
      state,
      correlationAcceptance,
      waitUntilDelivered,
      run,
      awaitTail,
    };
  }

  test("inFlight holds idle rebuild until the correlated resume is accepted", async () => {
    const {
      events,
      state,
      correlationAcceptance,
      waitUntilDelivered,
      run,
      awaitTail,
    } = occupancyResume();
    const running = run();

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

  test("approved correlation holds idle rebuild until tool.start", async () => {
    const {
      events,
      state,
      correlationAcceptance,
      waitUntilDelivered,
      run,
      awaitTail,
    } = occupancyResume();
    const running = run();

    await waitUntilDelivered;
    expect(events).toEqual(["deliver"]);
    expect(state.inFlight).toBe(1);
    expect(state.pendingReload).toBe(true);

    correlationAcceptance.observe({
      type: "message.correlated",
      data: {
        correlationId: "corr-1",
        message: {
          headers: { interchangeCorrelationId: "corr-1" },
          content: JSON.stringify({ outcome: "approved" }),
        },
      },
    });
    await Promise.resolve();
    expect(events).toEqual(["deliver"]);
    expect(state.inFlight).toBe(1);

    correlationAcceptance.observe({
      type: "tool.start",
      data: { call: { id: "call-ask" } },
    });
    await running;
    await awaitTail();

    expect(events).toEqual(["deliver", "rebuild"]);
    expect(state.inFlight).toBe(0);
  });

  test("generation bump settleAll releases occupancy without a correlation event", async () => {
    const correlationAcceptance = createCorrelationAcceptance();
    const generation = createDeliveryGeneration(() =>
      correlationAcceptance.settleAll(),
    );
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
      resolveParkedCallId: () => "call-ask",
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

describe("approval resume overlay on reactor timeout", () => {
  test("auto-abandons the overlay and unsticks occupancy when the parked call times out", async () => {
    const parkedOverlay = createParkedOverlayAbortBinding();
    const generation = createDeliveryGeneration();
    const turns = [userTurn()];
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
            event.resolve({
              allow: false,
              message:
                typeof event.signal?.reason === "string"
                  ? event.signal.reason
                  : "aborted",
            });
          },
          { once: true },
        );
        return true;
      },
      approvalTimeout: () => undefined,
      identitySignal: () => parkedOverlay.identitySignal(generation.signal()),
    });
    const gate = createPermissionGate({
      approvals: [],
      interactive: true,
      skipPermissions: false,
      reactorGated: true,
      requestApproval,
    });
    const delivered: unknown[] = [];
    const resume = createApprovalResume({
      resolveParkedCallId: () => "call-ask",
      getAgent: () => ({
        deliver: (message: unknown) => delivered.push(message),
        history: async () => turns,
      }),
      captureGeneration: generation.capture,
      registerOverlayAbort: parkedOverlay.registerOverlayAbort,
      parkedTimeoutPollMs: 5,
      gate,
    });
    const state = {
      inFlight: 0,
      pendingReload: false,
      reloadIfIdle: () => undefined,
    };

    const running = runWhileAgentBusy(state, async () => {
      await resume.handle(SUSPENDED);
    });
    await waitForOverlay;
    expect(state.inFlight).toBe(1);
    expect(overlay?.signal?.aborted).toBe(false);

    turns.push(approvalTimedOutTurn());
    await running;

    expect(overlay?.signal?.aborted).toBe(true);
    expect(overlay?.signal?.reason).toBe(APPROVAL_TIMEOUT_RESULT_TEXT);
    expect(delivered).toEqual([]);
    expect(state.inFlight).toBe(0);
  });
});
