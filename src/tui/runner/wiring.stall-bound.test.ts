import { describe, expect, test } from "bun:test";
import { attachSessionBridge, createRecordingPort } from "../runtime-bridge.js";
import { createAppShell } from "../shell/index.js";
import { withTestRenderer } from "../harness.js";
import {
  ASK_DIRECTOR_WAKE_PREFIX,
  pendingAskSnapshot,
  type PendingAskWake,
} from "../../subagent/fleet-report.js";
import { createFleetMailbox } from "../../subagent/agent-fleet.js";
import {
  createSubAgentSessionStore,
  type SubAgentSessionStore,
} from "../../subagent/session-store.js";
import { createFleetStallPollTick } from "./wiring.js";

// CL-8016: a silent primary turn (wake text sent, inference never starts)
// must not freeze the message queue and parked worker questions forever.
// The stall poll tick bounds that turn: past the stall threshold it aborts,
// the queued operator message gets a fresh turn, and parked asks either
// re-surface (escalated) or settle exactly once via the ask deadline.

const STALL_TIMEOUT_MS = 1_000;
const ASK_DEADLINE_MS = 60_000;

interface ParkedWorker {
  sessionId: string;
  questionId: string;
  resolved: string[];
  rejected: unknown[];
  wake: PendingAskWake;
}

function parkWorker(store: SubAgentSessionStore, tag: string): ParkedWorker {
  const session = store.start({
    description: `${tag} worker`,
    agentId: tag,
    brief: "brief",
    retained: true,
  });
  store.markRunning(session.id);
  const worker: ParkedWorker = {
    sessionId: session.id,
    questionId: `q-${tag}`,
    resolved: [],
    rejected: [],
    wake: {
      sessionId: session.id,
      agentId: tag,
      description: `${tag} worker`,
      question: `question ${tag}`,
      questionId: `q-${tag}`,
    },
  };
  const registered = store.registerAsk(session.id, {
    question: worker.wake.question,
    questionId: worker.wake.questionId,
    resolve: (answer: string) => {
      worker.resolved.push(answer);
    },
    reject: (reason: unknown) => {
      worker.rejected.push(reason);
    },
  });
  expect(registered).toBe(true);
  return worker;
}

function wakeDeliveries(
  port: ReturnType<typeof createRecordingPort>,
): string[] {
  return port.calls
    .filter(
      (call): call is Extract<typeof call, { op: "deliver" }> =>
        call.op === "deliver" &&
        call.item.text.includes(ASK_DIRECTOR_WAKE_PREFIX),
    )
    .map((call) => call.item.text);
}

describe("stall-bound primary turn (CL-8016)", () => {
  test("silent wake turn aborts past the bound; queued operator mail gets a fresh turn", async () => {
    await withTestRenderer(async (h) => {
      let nowMs = 1_000_000;
      const store = createSubAgentSessionStore({ now: () => nowMs });
      parkWorker(store, "a");
      parkWorker(store, "b");
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      });
      const port = createRecordingPort();
      const bridge = attachSessionBridge(shell, port, {
        now: () => nowMs,
        stallTimeoutMs: STALL_TIMEOUT_MS,
        schedule: () => () => undefined,
      });
      try {
        // Both workers parked: the wake text sends as a primary turn.
        bridge.handle({
          type: "agent-ask",
          asks: pendingAskSnapshot(store.list(), (id) => {
            const ask = store.peekAsk(id);
            return ask === undefined ? undefined : ask;
          }),
        });
        expect(bridge.turn.isProcessing).toBe(true);
        expect(wakeDeliveries(port)).toHaveLength(1);

        // The operator queues behind the silent turn; nothing moves.
        bridge.submit("operator: status?", "queue");
        expect(bridge.turn.isProcessing).toBe(true);
        expect(wakeDeliveries(port)).toHaveLength(1);

        nowMs += STALL_TIMEOUT_MS + 500;
        let mailDrives = 0;
        bridge.setMailboxMailDriver(() => {
          if (mailDrives > 0) return false;
          mailDrives += 1;
          bridge.beginSystemContinuation("operator: status?");
          return true;
        });
        // Production report: fresh snapshot reconciles bridge delivery state.
        const reportFleet = (): void => {
          bridge.handle({
            type: "agent-ask",
            asks: pendingAskSnapshot(store.list(), (id) => {
              const ask = store.peekAsk(id);
              return ask === undefined ? undefined : ask;
            }),
          });
        };
        const tick = createFleetStallPollTick(
          reportFleet,
          () => bridge.flushMailboxMail(),
          {
            abortStalledWakeTurn: () => bridge.abortStalledWakeTurn(),
            expireStaleAsks: () => {
              store.expireStaleAsks(ASK_DEADLINE_MS);
            },
          },
        );
        tick();

        // The silent turn aborted past the bound ...
        expect(bridge.turnMarkers().map((marker) => marker.path)).toContain(
          "stall-abort:awaiting-first-token",
        );
        // ... the queued operator message reached the port ...
        expect(
          port.calls.some(
            (call) =>
              call.op === "deliver" &&
              call.item.text.includes("operator: status?"),
          ),
        ).toBe(true);
        // ... and the queued mail got a fresh running turn.
        expect(mailDrives).toBe(1);
        expect(bridge.turn.isProcessing).toBe(true);
        expect(bridge.turn.status).toBe("running");

        // Settling the mail turn re-surfaces the still-parked asks, escalated.
        bridge.handle({ type: "inference.start", data: {} });
        bridge.handle({ type: "inference.done", data: {} });
        const wakes = wakeDeliveries(port);
        expect(wakes).toHaveLength(2);
        expect(wakes[1]).toContain("Re-surface");
      } finally {
        bridge.dispose();
      }
    });
  });

  test("two parked asks settle exactly once via the ask deadline", async () => {
    await withTestRenderer(async (h) => {
      let nowMs = 2_000_000;
      const store = createSubAgentSessionStore({ now: () => nowMs });
      const workers = [parkWorker(store, "a"), parkWorker(store, "b")];
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      });
      const port = createRecordingPort();
      const bridge = attachSessionBridge(shell, port, {
        now: () => nowMs,
        stallTimeoutMs: STALL_TIMEOUT_MS,
        schedule: () => () => undefined,
      });
      try {
        bridge.handle({
          type: "agent-ask",
          asks: workers.map((worker) => worker.wake),
        });
        expect(wakeDeliveries(port)).toHaveLength(1);

        const reportFleet = (): void => {
          bridge.handle({
            type: "agent-ask",
            asks: pendingAskSnapshot(store.list(), (id) => {
              const ask = store.peekAsk(id);
              return ask === undefined ? undefined : ask;
            }),
          });
        };
        const tick = createFleetStallPollTick(
          reportFleet,
          () => bridge.flushMailboxMail(),
          {
            abortStalledWakeTurn: () => bridge.abortStalledWakeTurn(),
            expireStaleAsks: () => {
              store.expireStaleAsks(ASK_DEADLINE_MS);
            },
          },
        );

        // Past the turn bound but inside the ask deadline: the wake turn
        // aborts and re-surfaces; nobody settles yet.
        nowMs += STALL_TIMEOUT_MS + 500;
        tick();
        expect(wakeDeliveries(port)).toHaveLength(2);
        for (const worker of workers) {
          expect(worker.resolved).toHaveLength(0);
          expect(worker.rejected).toHaveLength(0);
        }

        // Past the ask deadline: each question settles exactly once with an
        // explicit timeout error naming its question and session.
        nowMs += ASK_DEADLINE_MS;
        tick();
        for (const worker of workers) {
          expect(worker.resolved).toHaveLength(0);
          expect(worker.rejected).toHaveLength(1);
          const reason = String(worker.rejected[0]);
          expect(reason).toContain(worker.questionId);
          expect(reason).toContain(worker.sessionId);
          expect(store.resolveAsk(worker.sessionId, "late")).toBe(false);
          expect(store.hasPendingAsk(worker.sessionId)).toBe(false);
        }
      } finally {
        bridge.dispose();
      }
    });
  });

  test("stop clears the store and mailbox; late send_input names the teardown", async () => {
    await withTestRenderer(async (h) => {
      let nowMs = 3_000_000;
      const store = createSubAgentSessionStore({ now: () => nowMs });
      const workers = [parkWorker(store, "a"), parkWorker(store, "b")];
      const mailbox = createFleetMailbox(store);
      for (const worker of workers) mailbox.register(worker.sessionId);
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      });
      const port = createRecordingPort();
      const bridge = attachSessionBridge(shell, port, {
        now: () => nowMs,
        stallTimeoutMs: STALL_TIMEOUT_MS,
        schedule: () => () => undefined,
      });
      try {
        bridge.handle({
          type: "agent-ask",
          asks: workers.map((worker) => worker.wake),
        });
        expect(bridge.turn.isProcessing).toBe(true);

        store.teardown("Session closed");
        mailbox.clear();
        bridge.clearQueuedDelivery();

        expect(store.list()).toHaveLength(0);
        for (const worker of workers) {
          expect(mailbox.hasUncollectedTerminal(worker.sessionId)).toBe(false);
          const outcome = store.sendInputOne(worker.sessionId, "late answer");
          expect(outcome.ok).toBe(false);
          if (outcome.ok) continue;
          expect(outcome.hint).toContain("Session closed");
        }
        // The aborted wake turn is disarmed with the queue: nothing left to bound.
        expect(bridge.abortStalledWakeTurn()).toBe(false);
      } finally {
        bridge.dispose();
      }
    });
  });
});
