import { describe, expect, test } from "bun:test";

import type {
  ContextStore,
  ConversationTurn,
  InboundMessage,
} from "@intx/types/runtime";

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
  APPROVAL_INTERRUPTED_NOTICE,
  createApprovalResume,
} from "./approval-resume.js";
import { createCorrelationAcceptance } from "../tui/correlation-acceptance.js";
import type { PermissionGateEvent } from "../tui/gate-events.js";
import {
  createDeliveryGeneration,
  createSessionOperationQueue,
  SESSION_IDENTITY_ABORT_REASON,
} from "../tui/delivery-queue.js";
import { createQueuedApprovalDeliver } from "../tui/approval-delivery.js";
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
        if (!stillCurrent()) return "skipped";
        delivered.push(message);
        return "delivered";
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
        if (!stillCurrent()) return "skipped";
        delivered.push(message);
        return "delivered";
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
        if (!stillCurrent()) return "skipped";
        current.deliver(message);
        return "delivered";
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

// The store a rebuilt agent loads; `store.parked` flips the dropped call closed.
function parkedStore() {
  const store = { parked: true };
  return {
    store,
    storage: {
      load: async () =>
        ({
          pendingOperations: store.parked
            ? [
                {
                  kind: "approval",
                  correlationId: "corr-1",
                  suspendedCall: { id: "call-ask" },
                },
              ]
            : [],
        }) as unknown as Awaited<ReturnType<ContextStore["load"]>>,
    },
  };
}

describe("approval resume dropped approvals", () => {
  function droppableResume(
    resolveParkedCallId: () => string | Promise<string>,
  ) {
    const parkedCancel = { fn: undefined as (() => void) | undefined };
    const generation = createDeliveryGeneration(() => parkedCancel.fn?.());
    const delivered: unknown[] = [];
    let overlayReady: (() => void) | undefined;
    const overlayOpened = new Promise<void>((resolve) => {
      overlayReady = resolve;
    });
    const resume = createApprovalResume({
      resolveParkedCallId,
      getAgent: () => ({
        deliver: (message: unknown) => delivered.push(message),
        history: async () => [userTurn()],
      }),
      captureGeneration: generation.capture,
      registerParkedCancel: (cancel) => {
        parkedCancel.fn = cancel;
      },
      gate: {
        resolveSuspended: () => {
          overlayReady?.();
          return new Promise(() => undefined);
        },
      } as unknown as PermissionGate,
    });
    return { resume, generation, parkedCancel, delivered, overlayOpened };
  }

  test("a drop while the prompt is open is rejected once on the rebuilt agent", async () => {
    const { resume, generation, parkedCancel, overlayOpened } = droppableResume(
      () => "call-ask",
    );

    void resume.handle(SUSPENDED);
    await overlayOpened;
    const cancel = parkedCancel.fn;
    generation.bump();
    cancel?.();

    const rebuilt: InboundMessage[] = [];
    await resume.settleOn(
      { deliver: (message) => rebuilt.push(message) },
      parkedStore().storage,
    );
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]?.headers.interchangeCorrelationId).toBe("corr-1");
    expect(firstDeliveredContent(rebuilt)).toEqual({
      outcome: "rejected",
      message: APPROVAL_DROPPED_NOTICE,
    });
    expect(resume.droppedCalls.claim("call-ask")).toBe(true);
    expect(resume.droppedCalls.claim("call-ask")).toBe(false);
  });

  test("a drop before the parked call resolves sends the old agent nothing and still registers its call", async () => {
    let resolveCallId: ((id: string) => void) | undefined;
    const { resume, generation, delivered } = droppableResume(
      () =>
        new Promise<string>((resolve) => {
          resolveCallId = resolve;
        }),
    );

    const handling = resume.handle(SUSPENDED);
    generation.bump();
    resolveCallId?.("call-ask");

    expect(await handling).toBe(true);
    expect(delivered).toEqual([]);
    // Registered before the rebuilt agent's store is read, so a rehydrated
    // deadline that fires first still settles without a turn.
    await resume.prepareRebuild(parkedStore().storage);
    expect(resume.droppedCalls.claim("call-ask")).toBe(true);
  });

  test("a drop whose call id never resolved is registered from the outgoing store", async () => {
    const { resume, generation } = droppableResume(
      () => new Promise<string>(() => undefined),
    );
    void resume.handle(SUSPENDED);
    generation.bump();

    await resume.prepareRebuild(parkedStore().storage);

    expect(resume.droppedCalls.claim("call-ask")).toBe(true);
  });

  test("a drop is rejected again on every rebuild until the store shows the call closed", async () => {
    const { resume, generation, overlayOpened } = droppableResume(
      () => "call-ask",
    );
    void resume.handle(SUSPENDED);
    await overlayOpened;
    generation.bump();
    const { store, storage } = parkedStore();
    // A reactor closed before it accepts the rejection swallows it, so the
    // store still shows the call parked.
    const delivered: InboundMessage[] = [];
    const agent = {
      deliver: (message: InboundMessage) => delivered.push(message),
    };

    await resume.settleOn(agent, storage);
    expect(delivered).toHaveLength(1);
    await resume.settleOn(agent, storage);
    expect(delivered).toHaveLength(2);

    store.parked = false;
    await resume.settleOn(agent, storage);
    expect(delivered).toHaveLength(2);
    store.parked = true;
    await resume.settleOn(agent, storage);
    expect(delivered).toHaveLength(2);
  });

  test("rotation forgets drops and their calls", async () => {
    const { resume, generation, overlayOpened } = droppableResume(
      () => "call-ask",
    );
    void resume.handle(SUSPENDED);
    await overlayOpened;
    generation.bump();
    await resume.prepareRebuild(parkedStore().storage);

    resume.forgetUnsettled();

    const delivered: InboundMessage[] = [];
    await resume.settleOn(
      { deliver: (message) => delivered.push(message) },
      parkedStore().storage,
    );
    expect(delivered).toEqual([]);
    expect(resume.droppedCalls.claim("call-ask")).toBe(false);
  });
});

describe("approval resume decisions a closing reactor never ran", () => {
  function handedOverResume() {
    const oldAgentDelivered: InboundMessage[] = [];
    const resume = createApprovalResume({
      resolveParkedCallId: () => "call-ask",
      getAgent: () => ({
        deliver: (message: InboundMessage) => oldAgentDelivered.push(message),
        history: async () => [userTurn()],
      }),
      gate: {
        resolveSuspended: async () => ({ allow: true }),
      } as unknown as PermissionGate,
    });
    return { resume, oldAgentDelivered };
  }

  test("an approval whose delivery failed before the hand-over is rejected on the rebuilt agent with no turn", async () => {
    const resume = createApprovalResume({
      resolveParkedCallId: () => "call-ask",
      getAgent: () => ({
        deliver: () => undefined,
        history: async () => [userTurn()],
      }),
      deliver: async () => {
        throw new Error("agent build failed");
      },
      gate: {
        resolveSuspended: async () => ({ allow: true }),
      } as unknown as PermissionGate,
    });
    await expect(resume.handle(SUSPENDED)).rejects.toThrow(
      "agent build failed",
    );
    expect(resume.status("corr-1")).toBe("idle");

    await resume.prepareRebuild(parkedStore().storage);
    const rebuilt: InboundMessage[] = [];
    await resume.settleOn(
      { deliver: (message) => rebuilt.push(message) },
      parkedStore().storage,
    );

    expect(firstDeliveredContent(rebuilt)).toEqual({
      outcome: "rejected",
      message: APPROVAL_DROPPED_NOTICE,
    });
    expect(resume.droppedCalls.claim("call-ask")).toBe(true);
  });

  test("an approval handed over but still parked in the rebuilt store is rejected there with no turn", async () => {
    const { resume, oldAgentDelivered } = handedOverResume();
    expect(await resume.handle(SUSPENDED)).toBe(true);
    expect(firstDeliveredContent(oldAgentDelivered)).toEqual({
      outcome: "approved",
    });

    await resume.prepareRebuild(parkedStore().storage);
    const rebuilt: InboundMessage[] = [];
    await resume.settleOn(
      { deliver: (message) => rebuilt.push(message) },
      parkedStore().storage,
    );

    expect(firstDeliveredContent(rebuilt)).toEqual({
      outcome: "rejected",
      message: APPROVAL_DROPPED_NOTICE,
    });
    expect(resume.droppedCalls.claim("call-ask")).toBe(true);
  });

  test("an approval whose tool started is told it was interrupted, not dropped, on the rebuilt agent", async () => {
    // The start is announced while the delivery waits for it, before the
    // delivery resolves.
    const resumeRef: { current?: ReturnType<typeof createApprovalResume> } = {};
    const resume = createApprovalResume({
      resolveParkedCallId: () => "call-ask",
      getAgent: () => ({
        deliver: () => undefined,
        history: async () => [userTurn()],
      }),
      deliver: async () => {
        resumeRef.current?.toolStarted("call-ask");
        return "delivered" as const;
      },
      gate: {
        resolveSuspended: async () => ({ allow: true }),
      } as unknown as PermissionGate,
    });
    resumeRef.current = resume;
    expect(await resume.handle(SUSPENDED)).toBe(true);

    await resume.prepareRebuild(parkedStore().storage);
    const rebuilt: InboundMessage[] = [];
    await resume.settleOn(
      { deliver: (message) => rebuilt.push(message) },
      parkedStore().storage,
    );

    expect(firstDeliveredContent(rebuilt)).toEqual({
      outcome: "rejected",
      message: APPROVAL_INTERRUPTED_NOTICE,
    });
    expect(resume.droppedCalls.claim("call-ask")).toBe(true);
  });

  test("a tool start announced after the hand-over still tells the rebuilt agent the call was interrupted", async () => {
    const { resume } = handedOverResume();
    expect(await resume.handle(SUSPENDED)).toBe(true);
    resume.toolStarted("call-ask");

    const rebuilt: InboundMessage[] = [];
    await resume.settleOn(
      { deliver: (message) => rebuilt.push(message) },
      parkedStore().storage,
    );

    expect(firstDeliveredContent(rebuilt)).toEqual({
      outcome: "rejected",
      message: APPROVAL_INTERRUPTED_NOTICE,
    });
  });

  test("a tool start for a call no decision was offered for is ignored", async () => {
    const { resume } = handedOverResume();
    resume.toolStarted("call-ask");
    resume.toolStarted("call-elsewhere");
    expect(await resume.handle(SUSPENDED)).toBe(true);

    const rebuilt: InboundMessage[] = [];
    await resume.settleOn(
      { deliver: (message) => rebuilt.push(message) },
      parkedStore().storage,
    );

    expect(firstDeliveredContent(rebuilt)).toEqual({
      outcome: "rejected",
      message: APPROVAL_DROPPED_NOTICE,
    });
  });

  test("an approval whose tool started and closed on disk is forgotten", async () => {
    const { resume } = handedOverResume();
    expect(await resume.handle(SUSPENDED)).toBe(true);
    resume.toolStarted("call-ask");
    const { store, storage } = parkedStore();
    store.parked = false;
    await resume.prepareRebuild(storage);

    expect(resume.droppedCalls.claim("call-ask")).toBe(false);
    store.parked = true;
    const rebuilt: InboundMessage[] = [];
    await resume.settleOn(
      { deliver: (message) => rebuilt.push(message) },
      storage,
    );
    expect(rebuilt).toEqual([]);
  });

  test("an approval handed over and closed on disk is forgotten before the rebuild, claim and all", async () => {
    const { resume } = handedOverResume();
    expect(await resume.handle(SUSPENDED)).toBe(true);
    const { store, storage } = parkedStore();
    await resume.prepareRebuild(storage);
    store.parked = false;

    await resume.prepareRebuild(storage);

    expect(resume.droppedCalls.claim("call-ask")).toBe(false);
    store.parked = true;
    const rebuilt: InboundMessage[] = [];
    await resume.settleOn(
      { deliver: (message) => rebuilt.push(message) },
      storage,
    );
    expect(rebuilt).toEqual([]);
  });

  test("an approval handed over and closed on disk is forgotten", async () => {
    const { resume } = handedOverResume();
    expect(await resume.handle(SUSPENDED)).toBe(true);
    const { store, storage } = parkedStore();
    store.parked = false;

    const rebuilt: InboundMessage[] = [];
    await resume.settleOn(
      { deliver: (message) => rebuilt.push(message) },
      storage,
    );
    store.parked = true;
    await resume.settleOn(
      { deliver: (message) => rebuilt.push(message) },
      storage,
    );

    expect(rebuilt).toEqual([]);
  });
});

describe("interrupt while the operator's decision waits for delivery", () => {
  test("the skipped decision is recorded as a drop and settled on the rebuilt agent", async () => {
    const parkedCancel = { fn: undefined as (() => void) | undefined };
    const generation = createDeliveryGeneration(() => parkedCancel.fn?.());
    const sessionOps = createSessionOperationQueue();
    const oldAgentDelivered: InboundMessage[] = [];

    // Holds the session queue busy, as any earlier deliver or op would.
    let releaseBusy: (() => void) | undefined;
    void sessionOps.enqueue(
      () =>
        new Promise<void>((resolve) => {
          releaseBusy = resolve;
        }),
    );

    let decisionQueued: (() => void) | undefined;
    const queued = new Promise<void>((resolve) => {
      decisionQueued = resolve;
    });
    const resume = createApprovalResume({
      resolveParkedCallId: () => "call-ask",
      getAgent: () => ({
        deliver: (message: InboundMessage) => oldAgentDelivered.push(message),
        history: async () => [userTurn()],
      }),
      captureGeneration: generation.capture,
      registerParkedCancel: (cancel) => {
        parkedCancel.fn = cancel;
      },
      deliver: createQueuedApprovalDeliver({
        enqueue: (op) => {
          const queuedOp = sessionOps.enqueue(op);
          decisionQueued?.();
          return queuedOp;
        },
        fatalBuildError: () => null,
        deliverer: {
          deliver: async (message) => {
            oldAgentDelivered.push(message);
          },
        },
      }),
      gate: {
        resolveSuspended: async () => ({ allow: false, message: "no" }),
      } as unknown as PermissionGate,
    });

    const handling = resume.handle(SUSPENDED);
    await queued;

    const rebuilt: InboundMessage[] = [];
    startInterruptRebuild({
      deliveryGeneration: generation,
      markSendAborted: () => undefined,
      enqueue: sessionOps.enqueue,
      rebuild: async () => {
        await resume.settleOn(
          { deliver: (message) => rebuilt.push(message) },
          parkedStore().storage,
        );
      },
    });
    releaseBusy?.();
    expect(await handling).toBe(true);
    await sessionOps.awaitTail();

    expect(oldAgentDelivered).toEqual([]);
    expect(
      rebuilt.map((message) => message.headers.interchangeCorrelationId),
    ).toEqual(["corr-1"]);
    expect(resume.status("corr-1")).not.toBe("handed-over");
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
      deliver: async (message) => {
        await enqueue(async () => {
          const correlationId = message.headers.interchangeCorrelationId;
          const accepted =
            correlationId === undefined
              ? undefined
              : correlationAcceptance.wait(correlationId);
          agent.deliver(message);
          delivered?.();
          await accepted;
        });
        return "delivered" as const;
      },
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
      deliver: async (message) => {
        const correlationId = message.headers.interchangeCorrelationId;
        if (correlationId === undefined) return "skipped";
        const accepted = correlationAcceptance.wait(correlationId);
        waiting?.();
        await accepted;
        return "delivered";
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
