// An approval for a call parked during a turn that the TUI started by
// draining a queued delivery (ask_director wake, mailbox mail, or a queued
// operator prompt) must reach the reactor.
//
// The drained turn runs inside a sessionOps op (createLeftoverSend awaits the
// send). The operator's decision is delivered through session.ts's `deliver`,
// which enqueues another sessionOps op. If the drained op also awaited
// approvalResume.handle, that delivery would be chained behind the op waiting
// for it and never run: no deliver, no acceptance timeout, no log line, the
// reactor answering the parked call with `approval timed out` an hour later,
// and a wedged queue that hangs every later send.
//
// Uses the real createDeliverRouting + createSubmitPath (submit.ts), the real
// session queue / generation, the real createApprovalResume, and the real
// createApprovalDeliverer. The approvalResume `deliver` closure is copied
// verbatim from src/tui/runner/session.ts (createApprovalResume wiring).

import { expect, test } from "bun:test";
import type { Agent, SendResult } from "@intx/agent";
import type { InboundMessage } from "@intx/types/runtime";

import {
  createDeliveryGeneration,
  createSessionOperationQueue,
} from "../delivery-queue.js";
import { createApprovalDeliverer } from "../approval-delivery.js";
import {
  createApprovalResume,
  createSuspendedApprovalRecovery,
} from "../../session/approval-resume.js";
import type { PermissionGate } from "../../permission/gate.js";
import { ASK_DIRECTOR_WAKE_PREFIX } from "../../subagent/fleet-report.js";
import { createDeliverRouting, createSubmitPath } from "./submit.js";
import type { RunnerServices, RunnerState } from "./state.js";

const CORRELATION = "00000000-0000-4000-8000-0000000000a1";
const PARKED_CALL = "call_parked_approve_worker";

function harness() {
  const delivered: InboundMessage[] = [];
  const waiters = new Map<string, () => void>();
  const acceptance = {
    wait: (id: string) =>
      new Promise<void>((resolve) => {
        waiters.set(id, resolve);
      }),
    settle: (id: string) => waiters.get(id)?.(),
    abandon: (id: string) => {
      waiters.delete(id);
    },
  };
  // Stub reactor: send() parks approve_worker_call on the approval gate;
  // deliver() of a correlated decision is accepted at once.
  const agent = {
    send: async (): Promise<SendResult> =>
      ({
        type: "suspended",
        correlationId: CORRELATION,
        approvalSnapshot: {
          name: "approve_worker_call",
          description: "Approve one exact pending worker-denied call.",
          inputSchema: { type: "object" },
          arguments: {
            target: "call_worker_qa_lead",
            question_id: "ask-1",
            request_id: "00000000-0000-4000-8000-0000000000b2",
          },
        },
      }) as SendResult,
    deliver: (message: InboundMessage) => {
      delivered.push(message);
      const id = message.headers.interchangeCorrelationId;
      if (id !== undefined) acceptance.settle(id);
    },
    history: async () => [],
  } as unknown as Agent;

  let gateAsked = 0;
  // Operator answers allow-once immediately.
  const gate = {
    resolveSuspended: async () => {
      gateAsked++;
      return { allow: true };
    },
  } as unknown as PermissionGate;

  const sessionOps = createSessionOperationQueue();
  const deliveryGeneration = createDeliveryGeneration();
  const state = {
    sessionId: "s",
    config: { cwd: "/tmp", providers: [] },
    currentAgent: agent,
    currentStorage: null,
    fatalBuildError: null,
    inFlight: 0,
    sendAborted: false,
    approvalPersistNotice: {},
    credentialRecovery: {
      begin: () => ({ failedProvider: "p" }),
      settle: () => null,
    },
    credentialRecoveryAttempts: new Map(),
    reconnectRecovery: { begin: () => ({}), settle: () => null },
    reconnectRecoveryAttempts: new Map(),
    host: {
      bridge: {
        setSuspendedApprovalRecovery: () => undefined,
        parentCycleLive: false,
      },
      shell: {},
    },
  } as unknown as RunnerState;

  const approvalDeliverer = createApprovalDeliverer({
    deliverToAgent: (message) => agent.deliver(message),
    acceptance,
    timeoutMs: 1_000,
  });
  const approvalResume = createApprovalResume({
    getAgent: () => agent,
    resolveParkedCallId: () => PARKED_CALL,
    captureGeneration: deliveryGeneration.capture,
    parkedTimeoutPollMs: 5,
    // Verbatim from src/tui/runner/session.ts.
    deliver: (message, stillCurrent) => {
      return sessionOps.enqueue(async () => {
        if (!stillCurrent()) return;
        if (state.fatalBuildError !== null) throw state.fatalBuildError;
        await approvalDeliverer.deliver(message);
      });
    },
    gate,
  });
  const suspendedApprovalRecovery = createSuspendedApprovalRecovery({
    storage: () => undefined,
    resume: approvalResume,
  });
  const services = {
    sessionOps,
    deliveryGeneration,
    approvalResume,
    suspendedApprovalRecovery,
    providerFailureAttempts: {
      begin: () => ({ observed: false, presented: false, error: undefined }),
      sendSettled: () => undefined,
      markPresented: () => undefined,
    },
  } as unknown as RunnerServices;
  const live = {
    attemptIdentity: () => ({ providerId: "p" }) as never,
    agentProxy: agent,
  };
  createSubmitPath(state, services, live);
  const route = createDeliverRouting(state, services, live);
  return {
    state,
    route,
    sessionOps,
    delivered,
    gateAsked: () => gateAsked,
  };
}

const settleWithin = async (p: Promise<unknown>, ms: number) =>
  Promise.race([
    p.then(() => "settled" as const),
    new Promise<"pending">((r) => setTimeout(() => r("pending"), ms)),
  ]);

test("control: operator-typed send delivers the allow-once decision", async () => {
  const h = harness();
  const send = h.state.sendWithAttemptIdentity;
  if (send === undefined) throw new Error("no send path");
  // sendUserPrompt -> sendWithAttemptIdentity runs outside any sessionOps op.
  await send({
    ref: { uid: 0, mailbox: "INBOX" },
    headers: { from: "user@local", to: ["agent@local"], date: "" },
    flags: [],
    content: "approve it",
  } as unknown as InboundMessage);
  expect(h.gateAsked()).toBe(1);
  expect(h.delivered.map((m) => m.headers.interchangeType)).toEqual([
    "approval.granted",
  ]);
});

test("wake-drained turn: allow-once decision reaches the reactor", async () => {
  const h = harness();
  let settled: unknown;
  // ask_director wake drained at idle: host deliver(kind "queue") ->
  // createLeftoverSend -> sessionOps op awaiting the whole send.
  h.route(
    `${ASK_DIRECTOR_WAKE_PREFIX} — worker qa-lead parked question ask-1`,
    "queue",
    [],
    (result) => {
      settled = result;
    },
    false,
  );
  await new Promise((r) => setTimeout(r, 200));
  expect(h.gateAsked()).toBe(1); // operator answered allow-once
  // Before the fix the decision queued behind the op awaiting it.
  expect(h.delivered.map((m) => m.headers.interchangeType)).toEqual([
    "approval.granted",
  ]);
  expect(settled).toEqual({ status: "accepted" });
  // And the queue must not be wedged: a later operator send awaits the tail.
  expect(await settleWithin(h.sessionOps.awaitTail(), 200)).toBe("settled");
});
