/**
 * An ask-tier call parked by a turn that started with a bare `deliver()` (a
 * worker wake, a background shell exit, a queued prompt on an idle agent)
 * emits `reactor.gate.blocked` with no `send()` awaiting a `suspended`
 * result, so nothing raises the approval. These tests drive the real reactor
 * to pin both the silent park and the two ways the TUI now surfaces it: the
 * stream route, and the watchdog's re-presentation of the persisted approval.
 */
import { describe, expect, test } from "bun:test";

import type { ReactorEmittedEvent } from "@intx/inference";
import type { InboundMessage } from "@intx/types/runtime";

import { OPERATOR_ORIGINATED_FLAG } from "../src/agent/message-provenance.js";
import { createPermissionGate } from "../src/permission/gate.js";
import { createReactorAuthorize } from "../src/permission/reactor-authorize.js";
import {
  createApprovalResume,
  createSuspendedApprovalRecovery,
  resolveParkedCallIdFromStore,
} from "../src/session/approval-resume.js";
import {
  closeIntegrationSession,
  openIntegrationSession,
  toolDoneEvents,
  type IntegrationSession,
} from "./integration-harness.js";
import { defined } from "../testkit/defined.js";

const CURL_CALL = {
  name: "run_shell",
  args: { command: "curl -sS https://example.com" },
};

function deferredApprovalGate() {
  const asks: string[] = [];
  let release: ((outcome: { allow: boolean }) => void) | undefined;
  return {
    asks,
    gate: createPermissionGate({
      approvals: [],
      interactive: true,
      skipPermissions: false,
      auto: false,
      reactorGated: true,
      requestApproval: (request) => {
        asks.push(`${request.tool}:${request.subject}`);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    }),
    approve: () => release?.({ allow: true }),
  };
}

type Ctx = ReturnType<typeof deferredApprovalGate>;

function deliveredPrompt(text: string): InboundMessage {
  return {
    ref: { uid: 1, mailbox: "INBOX" },
    headers: {
      from: "user@local",
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: `<${crypto.randomUUID()}@local>`,
      interchangeType: "conversation.message",
    },
    flags: [OPERATOR_ORIGINATED_FLAG],
    content: text,
    signatureStatus: "missing",
  };
}

async function waitFor(
  predicate: () => boolean,
  what: string,
  ms = 3_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Starts a turn with a bare deliver and returns once the reactor has parked.
 * `onParked` stands in for the stream sink's gate-blocked hook.
 */
async function parkWithBareDeliver(
  session: IntegrationSession,
  onParked?: (data: GateData) => void,
) {
  const events: ReactorEmittedEvent[] = [];
  let reply: string | undefined;
  const stream = session.agent.stream();
  void (async () => {
    for await (const event of stream) {
      events.push(event);
      if (event.type === "reactor.gate.blocked") onParked?.(event.data);
      if (event.type === "connector.reply") reply = event.data.content;
    }
  })().catch(() => undefined);
  void session.harness
    .run({ wallClockBudgetMs: 30_000 })
    .catch(() => undefined);

  session.agent.deliver(deliveredPrompt("Please fetch example.com with curl."));
  await waitFor(
    () => events.some((event) => event.type === "reactor.gate.blocked"),
    "the reactor to park",
  );
  const blocked = events.find((event) => event.type === "reactor.gate.blocked");
  if (blocked?.type !== "reactor.gate.blocked") throw new Error("not parked");
  return { events, blocked: blocked.data, reply: () => reply };
}

type GateData = Extract<
  ReactorEmittedEvent,
  { type: "reactor.gate.blocked" }
>["data"];

async function open(ctx: Ctx) {
  const session = await openIntegrationSession({
    permissionGate: ctx.gate,
    authorize: createReactorAuthorize(ctx.gate),
  });
  session.harness.scenario.replyOnce("anthropic", { toolCalls: [CURL_CALL] });
  session.harness.scenario.replyOnce("anthropic", { text: "Fetched." });
  return session;
}

function recoveryFor(session: IntegrationSession, ctx: Ctx) {
  const resume = createApprovalResume({
    getAgent: () => session.agent,
    resolveParkedCallId: (correlationId) =>
      resolveParkedCallIdFromStore(session.storage, correlationId),
    gate: ctx.gate,
  });
  return {
    resume,
    recovery: createSuspendedApprovalRecovery({
      storage: () => session.storage,
      resume,
    }),
  };
}

describe("integration: ask-tier call parked by a bare deliver", () => {
  test.serial(
    "parks with a persisted approval and nobody asks the operator",
    async () => {
      const ctx = deferredApprovalGate();
      const session = await open(ctx);
      try {
        const turn = await parkWithBareDeliver(session);
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(turn.blocked.reason).toBe("approval");
        expect(turn.blocked.correlationId).toBeDefined();
        const parkedCallId = await resolveParkedCallIdFromStore(
          session.storage,
          defined(turn.blocked.correlationId),
        );
        expect(parkedCallId).toBeDefined();
        // The silent hang: parked, persisted, and never presented.
        expect(ctx.asks).toEqual([]);
        expect(toolDoneEvents(turn.events)).toHaveLength(0);
        expect(turn.reply()).toBeUndefined();
      } finally {
        await closeIntegrationSession(session);
      }
    },
  );

  test.serial(
    "routing the gate event raises one ask and the approved call runs once",
    async () => {
      const ctx = deferredApprovalGate();
      const session = await open(ctx);
      try {
        const { recovery } = recoveryFor(session, ctx);
        const turn = await parkWithBareDeliver(session, (data) =>
          recovery.observeParked(data, () => true),
        );
        await waitFor(() => ctx.asks.length === 1, "the operator ask");

        ctx.approve();
        await waitFor(() => turn.reply() !== undefined, "the resumed reply");

        expect(ctx.asks).toHaveLength(1);
        expect(
          turn.events.some(
            (e) => e.type === "tool.start" && e.data.call.name === "run_shell",
          ),
        ).toBe(true);
        expect(turn.reply()).toBe("Fetched.");
      } finally {
        await closeIntegrationSession(session);
      }
    },
  );

  test.serial(
    "the watchdog re-presents the persisted approval when nothing routed it",
    async () => {
      const ctx = deferredApprovalGate();
      const session = await open(ctx);
      try {
        const { resume, recovery } = recoveryFor(session, ctx);
        const turn = await parkWithBareDeliver(session);
        expect(ctx.asks).toEqual([]);

        recovery.capture(
          {
            type: "suspended",
            correlationId: defined(turn.blocked.correlationId),
            ...(turn.blocked.approvalSnapshot !== undefined
              ? { approvalSnapshot: turn.blocked.approvalSnapshot }
              : {}),
          },
          () => true,
        );
        const attempt = recovery.tryResumeOnce();
        await waitFor(() => ctx.asks.length === 1, "the re-presented ask");
        ctx.approve();

        expect(await attempt).toEqual({ handled: true, code: "resumed" });
        await waitFor(() => turn.reply() !== undefined, "the resumed reply");
        expect(ctx.asks).toHaveLength(1);
        expect(turn.reply()).toBe("Fetched.");
        expect(resume.status(defined(turn.blocked.correlationId))).toBe(
          "handed-over",
        );
      } finally {
        await closeIntegrationSession(session);
      }
    },
  );
});
