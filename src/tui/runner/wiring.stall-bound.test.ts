import { describe, expect, test } from "bun:test";
import {
  attachSessionBridge,
  createRecordingPort,
  type SessionBridge,
  type TurnMonitorOptions,
} from "../runtime-bridge.js";
import { isPaused } from "../delivery-queue.js";
import { withAppShell } from "../test-helpers.js";
import {
  ASK_DIRECTOR_WAKE_PREFIX,
  pendingAskSnapshot,
  type PendingAskWake,
} from "../../subagent/fleet-report.js";
import { createFleetMailbox } from "../../subagent/agent-fleet.js";
import {
  ASK_DEADLINE_MS,
  createSubAgentSessionStore,
  type SubAgentSessionStore,
} from "../../subagent/session-store.js";
import { cancelWorkersForStop, createFleetStallPollTick } from "./wiring.js";

// A silent primary turn (wake sent, inference never starts) must not freeze
// the queue and parked questions forever: the stall poll aborts it past the
// threshold, the queued message gets a fresh turn, and parked asks either
// re-surface (escalated) or settle exactly once via the ask deadline.

const STALL_TIMEOUT_MS = 1_000;

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

/** Wake deliveries issued after the interrupt. */
function wakeDeliveriesAfterInterrupt(
  port: ReturnType<typeof createRecordingPort>,
): number {
  const interruptAt = port.calls.findIndex((call) => call.op === "interrupt");
  expect(interruptAt).toBeGreaterThanOrEqual(0);
  return port.calls
    .slice(interruptAt + 1)
    .filter(
      (call) =>
        call.op === "deliver" &&
        call.item.text.includes(ASK_DIRECTOR_WAKE_PREFIX),
    ).length;
}

interface StallFixture {
  store: SubAgentSessionStore;
  port: ReturnType<typeof createRecordingPort>;
  bridge: SessionBridge;
  clock: { now: number };
  reportFleet: () => void;
}

/** The production poll-tick shape, wired to this fixture. */
function stallTick(
  fixture: Pick<StallFixture, "store" | "bridge" | "reportFleet">,
): () => void {
  const { store, bridge, reportFleet } = fixture;
  return createFleetStallPollTick(
    reportFleet,
    () => bridge.flushMailboxMail(),
    {
      abortStalledWakeTurn: () => bridge.abortStalledWakeTurn(),
      abortExpiredWakeTurn: (expiredThisTick) =>
        bridge.abortExpiredWakeTurn(expiredThisTick),
      expireStaleAsks: () => store.expireStaleAsks(ASK_DEADLINE_MS),
    },
  );
}

async function withStallBridge(
  startNow: number,
  fn: (fixture: StallFixture) => Promise<void> | void,
  schedule?: TurnMonitorOptions["schedule"],
): Promise<void> {
  await withAppShell(async (shell) => {
    const clock = { now: startNow };
    const store = createSubAgentSessionStore({ now: () => clock.now });
    const port = createRecordingPort();
    const bridge = attachSessionBridge(shell, port, {
      now: () => clock.now,
      stallTimeoutMs: STALL_TIMEOUT_MS,
      schedule: schedule ?? (() => () => undefined),
    });
    // Production report: fresh snapshot reconciles delivery state.
    const reportFleet = (): void => {
      bridge.handle({
        type: "agent-ask",
        asks: pendingAskSnapshot(store.list(), (id) => store.peekAsk(id)),
      });
    };
    try {
      await fn({ store, port, bridge, clock, reportFleet });
    } finally {
      bridge.dispose();
    }
  });
}

describe("stall-bound primary turn (CL-8016)", () => {
  test("silent wake turn aborts past the bound; queued operator mail gets a fresh turn", async () => {
    await withStallBridge(
      1_000_000,
      async ({ store, port, bridge, clock, reportFleet }) => {
        parkWorker(store, "a");
        parkWorker(store, "b");
        // Both parked: the wake sends as a primary turn.
        reportFleet();
        expect(bridge.turn.isProcessing).toBe(true);
        expect(wakeDeliveries(port)).toHaveLength(1);

        // The operator queues behind the silent turn.
        bridge.submit("operator: status?", "queue");
        expect(bridge.turn.isProcessing).toBe(true);
        expect(wakeDeliveries(port)).toHaveLength(1);

        clock.now += STALL_TIMEOUT_MS + 500;
        let mailDrives = 0;
        bridge.setMailboxMailDriver(() => {
          if (mailDrives > 0) return false;
          mailDrives += 1;
          bridge.beginSystemContinuation("operator: status?");
          return true;
        });
        const tick = stallTick({ store, bridge, reportFleet });
        tick();

        // Silent turn aborted, inference interrupted before any new deliver,
        // queued message reached the port, and mail got a fresh running turn.
        expect(bridge.turnMarkers().map((marker) => marker.path)).toContain(
          "stall-abort:awaiting-first-token",
        );
        // Stall-abort is a non-operator path (CL-10149): it must NOT set the
        // operator pause flag, so it keeps the old drain semantics.
        expect(isPaused(bridge.shell.session)).toBe(false);
        expect(wakeDeliveriesAfterInterrupt(port)).toBe(0);
        expect(
          port.calls.some(
            (call) =>
              call.op === "deliver" &&
              call.item.text.includes("operator: status?"),
          ),
        ).toBe(true);
        expect(mailDrives).toBe(1);
        expect(bridge.turn.isProcessing).toBe(true);
        expect(bridge.turn.status).toBe("running");

        // Settling the mail turn re-surfaces the parked asks, escalated.
        bridge.handle({ type: "inference.start", data: {} });
        bridge.handle({ type: "inference.done", data: {} });
        const wakes = wakeDeliveries(port);
        expect(wakes).toHaveLength(2);
        expect(wakes[1]).toContain("Re-surface");
      },
    );
  });

  test("stall monitor abort of an armed wake lets occupancy take the next turn", async () => {
    let monitorTick: (() => void) | undefined;
    await withStallBridge(
      4_000_000,
      async ({ store, port, bridge, clock, reportFleet }) => {
        parkWorker(store, "a");
        reportFleet();
        expect(bridge.turn.isProcessing).toBe(true);
        expect(wakeDeliveries(port)).toHaveLength(1);

        let mailDrives = 0;
        bridge.setMailboxMailDriver(() => {
          if (mailDrives > 0) return false;
          mailDrives += 1;
          bridge.beginSystemContinuation("mailbox occupancy");
          return true;
        });

        clock.now += STALL_TIMEOUT_MS + 500;
        expect(monitorTick).toBeDefined();
        monitorTick?.();

        // The #1095 monitor tick, not the 5s fleet poll, aborts; occupancy
        // must win the next turn, not a re-surface wake.
        expect(wakeDeliveriesAfterInterrupt(port)).toBe(0);
        expect(mailDrives).toBe(1);
        expect(wakeDeliveries(port)).toHaveLength(1);
        expect(bridge.turn.isProcessing).toBe(true);
        expect(bridge.turn.status).toBe("running");
      },
      (fn) => {
        monitorTick = fn;
        return () => {
          monitorTick = undefined;
        };
      },
    );
  });

  test("two parked asks settle exactly once via the ask deadline", async () => {
    await withStallBridge(
      2_000_000,
      async ({ store, port, bridge, clock, reportFleet }) => {
        const workers = [parkWorker(store, "a"), parkWorker(store, "b")];
        bridge.handle({
          type: "agent-ask",
          asks: workers.map((worker) => worker.wake),
        });
        expect(wakeDeliveries(port)).toHaveLength(1);

        const tick = stallTick({ store, bridge, reportFleet });

        // Past the turn bound, inside the ask deadline: abort and re-surface only.
        clock.now += STALL_TIMEOUT_MS + 500;
        tick();
        expect(wakeDeliveries(port)).toHaveLength(2);
        for (const worker of workers) {
          expect(worker.resolved).toHaveLength(0);
          expect(worker.rejected).toHaveLength(0);
        }

        // Past the ask deadline: each question settles once with a timeout
        // error naming its question and session.
        clock.now += ASK_DEADLINE_MS;
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
        // Expiring the asks must also end the silent wake; disarm alone would
        // hang isProcessing with nothing left to re-surface.
        expect(bridge.turn.isProcessing).toBe(false);
      },
    );
  });

  test("late wake expiring at the deadline ends the silent turn without the stall bound (CL-8060)", async () => {
    await withStallBridge(
      5_000_000,
      async ({ store, port, bridge, clock, reportFleet }) => {
        const worker = parkWorker(store, "late");
        const askedAt = clock.now;
        // The wake lands just inside the ask deadline, still inside its stall window.
        clock.now = askedAt + ASK_DEADLINE_MS - 500;
        reportFleet();
        expect(bridge.turn.isProcessing).toBe(true);
        expect(wakeDeliveries(port)).toHaveLength(1);

        const tick = stallTick({ store, bridge, reportFleet });

        // Past the deadline but inside the stall window: settle, end idle,
        // no stall bound.
        clock.now = askedAt + ASK_DEADLINE_MS + 1;
        tick();

        expect(worker.resolved).toHaveLength(0);
        expect(worker.rejected).toHaveLength(1);
        expect(String(worker.rejected[0])).toContain(worker.questionId);
        expect(bridge.turn.isProcessing).toBe(false);
        const paths = bridge.turnMarkers().map((marker) => marker.path);
        expect(paths).toContain("expire-abort");
        expect(paths.some((path) => path.startsWith("stall-abort"))).toBe(
          false,
        );
        // Nothing left to re-surface; the expired wake does not resend.
        expect(wakeDeliveries(port)).toHaveLength(1);
        expect(bridge.abortStalledWakeTurn()).toBe(false);
        expect(bridge.abortExpiredWakeTurn(true)).toBe(false);
      },
    );
  });

  test("send_input resolving the last ask on a live wake turn does not expire-abort", async () => {
    await withStallBridge(
      6_000_000,
      async ({ store, port, bridge, reportFleet }) => {
        const worker = parkWorker(store, "live");
        reportFleet();
        expect(bridge.turn.isProcessing).toBe(true);
        expect(wakeDeliveries(port)).toHaveLength(1);

        // Parent is inferring the wake when send_input answers the last ask.
        bridge.handle({ type: "inference.start", data: {} });
        expect(store.sendInputOne(worker.sessionId, "the answer")).toEqual({
          ok: true,
          status: "running",
        });
        expect(worker.resolved).toEqual(["the answer"]);
        expect(store.hasPendingAsk(worker.sessionId)).toBe(false);

        // Subscribe-time report empties pendingAskWake while inference is live.
        reportFleet();
        const tick = stallTick({ store, bridge, reportFleet });

        tick();

        expect(bridge.turn.isProcessing).toBe(true);
        const paths = bridge.turnMarkers().map((marker) => marker.path);
        expect(paths).toContain("infer-start");
        expect(paths).not.toContain("expire-abort");
        expect(paths.some((path) => path.startsWith("stall-abort"))).toBe(
          false,
        );
        expect(wakeDeliveries(port)).toHaveLength(1);
      },
    );
  });

  test("stop clears the store and mailbox; late send_input names the teardown", async () => {
    await withStallBridge(3_000_000, async ({ store, bridge }) => {
      const workers = [parkWorker(store, "a"), parkWorker(store, "b")];
      const mailbox = createFleetMailbox(store);
      for (const worker of workers) mailbox.register(worker.sessionId);
      bridge.handle({
        type: "agent-ask",
        asks: workers.map((worker) => worker.wake),
      });
      expect(bridge.turn.isProcessing).toBe(true);

      // Stop through the production path, not hand-clears.
      await cancelWorkersForStop({
        subAgentSessions: store,
        fleetRecords: mailbox,
        bridge,
      });

      expect(store.list()).toHaveLength(0);
      for (const worker of workers) {
        expect(mailbox.hasUncollectedTerminal(worker.sessionId)).toBe(false);
        const outcome = store.sendInputOne(worker.sessionId, "late answer");
        expect(outcome.ok).toBe(false);
        if (outcome.ok) continue;
        expect(outcome.hint).toContain("Session closed");
      }
      // The aborted wake turn is disarmed with the queue.
      expect(bridge.abortStalledWakeTurn()).toBe(false);
    });
  });
});
