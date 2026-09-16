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
  ASK_DEADLINE_MS,
  createSubAgentSessionStore,
  type SubAgentSessionStore,
} from "../../subagent/session-store.js";
import { STALL_TIMEOUT_MS as PROD_STALL_TIMEOUT_MS } from "../stall-watchdog.js";
import { cancelWorkersForStop, createFleetStallPollTick } from "./wiring.js";

// CL-8016: a silent primary turn (wake text sent, inference never starts)
// must not freeze the message queue and parked worker questions forever.
// The stall poll tick bounds that turn via shouldAbortForStall (including
// awaiting-first-token after #1095): past the stall threshold it aborts,
// the queued operator message gets a fresh turn, and parked asks either
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
            expireStaleAsks: () => store.expireStaleAsks(ASK_DEADLINE_MS),
          },
        );
        tick();

        // The silent turn aborted past the bound ...
        expect(bridge.turnMarkers().map((marker) => marker.path)).toContain(
          "stall-abort:awaiting-first-token",
        );
        // ... the hung inference was interrupted before any new deliver ...
        const interruptAt = port.calls.findIndex(
          (call) => call.op === "interrupt",
        );
        expect(interruptAt).toBeGreaterThanOrEqual(0);
        const wakeAfterInterrupt = port.calls
          .slice(interruptAt + 1)
          .filter(
            (call): call is Extract<typeof call, { op: "deliver" }> =>
              call.op === "deliver" &&
              call.item.text.includes(ASK_DIRECTOR_WAKE_PREFIX),
          );
        expect(wakeAfterInterrupt).toHaveLength(0);
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

  test("stall monitor abort of an armed wake lets occupancy take the next turn", async () => {
    await withTestRenderer(async (h) => {
      let nowMs = 4_000_000;
      let monitorTick: (() => void) | undefined;
      const store = createSubAgentSessionStore({ now: () => nowMs });
      parkWorker(store, "a");
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      });
      const port = createRecordingPort();
      const bridge = attachSessionBridge(shell, port, {
        now: () => nowMs,
        stallTimeoutMs: STALL_TIMEOUT_MS,
        schedule: (fn) => {
          monitorTick = fn;
          return () => {
            monitorTick = undefined;
          };
        },
      });
      try {
        bridge.handle({
          type: "agent-ask",
          asks: pendingAskSnapshot(store.list(), (id) => {
            const ask = store.peekAsk(id);
            return ask === undefined ? undefined : ask;
          }),
        });
        expect(bridge.turn.isProcessing).toBe(true);
        expect(wakeDeliveries(port)).toHaveLength(1);

        let mailDrives = 0;
        bridge.setMailboxMailDriver(() => {
          if (mailDrives > 0) return false;
          mailDrives += 1;
          bridge.beginSystemContinuation("mailbox occupancy");
          return true;
        });

        nowMs += STALL_TIMEOUT_MS + 500;
        expect(monitorTick).toBeDefined();
        monitorTick?.();

        // Production abort is the #1095 monitor tick → doInterrupt, not the
        // 5s fleet poll. Occupancy must win that next turn; a re-surface wake
        // must not start processing first.
        const interruptAt = port.calls.findIndex(
          (call) => call.op === "interrupt",
        );
        expect(interruptAt).toBeGreaterThanOrEqual(0);
        expect(
          port.calls
            .slice(interruptAt + 1)
            .some(
              (call) =>
                call.op === "deliver" &&
                call.item.text.includes(ASK_DIRECTOR_WAKE_PREFIX),
            ),
        ).toBe(false);
        expect(mailDrives).toBe(1);
        expect(wakeDeliveries(port)).toHaveLength(1);
        expect(bridge.turn.isProcessing).toBe(true);
        expect(bridge.turn.status).toBe("running");
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
            expireStaleAsks: () => store.expireStaleAsks(ASK_DEADLINE_MS),
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
        // Expiring the asks must also end the silent wake — disarm without
        // abort would leave isProcessing hung with nothing left to re-surface.
        expect(bridge.turn.isProcessing).toBe(false);
      } finally {
        bridge.dispose();
      }
    });
  });

  test("late wake expiring at the deadline ends the silent turn without the stall bound (CL-8060)", async () => {
    await withTestRenderer(async (h) => {
      let nowMs = 5_000_000;
      const store = createSubAgentSessionStore({ now: () => nowMs });
      const worker = parkWorker(store, "late");
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
        const askedAt = nowMs;
        // The wake lands late: just inside the ask deadline, so the silent
        // turn is still inside its stall window when the deadline hits.
        nowMs = askedAt + ASK_DEADLINE_MS - 500;
        bridge.handle({
          type: "agent-ask",
          asks: pendingAskSnapshot(store.list(), (id) => {
            const ask = store.peekAsk(id);
            return ask === undefined ? undefined : ask;
          }),
        });
        expect(bridge.turn.isProcessing).toBe(true);
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
            abortExpiredWakeTurn: (expiredThisTick) =>
              bridge.abortExpiredWakeTurn(expiredThisTick),
            expireStaleAsks: () => store.expireStaleAsks(ASK_DEADLINE_MS),
          },
        );

        // Past the ask deadline but still inside the wake turn's stall window:
        // the deadline settles the question and the silent turn must end idle
        // without waiting for the stall bound.
        nowMs = askedAt + ASK_DEADLINE_MS + 1;
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
        // Nothing left to re-surface: the expired wake does not send again.
        expect(wakeDeliveries(port)).toHaveLength(1);
        expect(bridge.abortStalledWakeTurn()).toBe(false);
        expect(bridge.abortExpiredWakeTurn(true)).toBe(false);
      } finally {
        bridge.dispose();
      }
    });
  });

  test("send_input resolving the last ask on a live wake turn does not expire-abort", async () => {
    await withTestRenderer(async (h) => {
      let nowMs = 6_000_000;
      const store = createSubAgentSessionStore({ now: () => nowMs });
      const worker = parkWorker(store, "live");
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
          asks: pendingAskSnapshot(store.list(), (id) => {
            const ask = store.peekAsk(id);
            return ask === undefined ? undefined : ask;
          }),
        });
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

        const reportFleet = (): void => {
          bridge.handle({
            type: "agent-ask",
            asks: pendingAskSnapshot(store.list(), (id) => {
              const ask = store.peekAsk(id);
              return ask === undefined ? undefined : ask;
            }),
          });
        };
        // Subscribe-time report empties pendingAskWake while inference is live.
        reportFleet();
        const tick = createFleetStallPollTick(
          reportFleet,
          () => bridge.flushMailboxMail(),
          {
            abortStalledWakeTurn: () => bridge.abortStalledWakeTurn(),
            abortExpiredWakeTurn: (expiredThisTick) =>
              bridge.abortExpiredWakeTurn(expiredThisTick),
            expireStaleAsks: () => store.expireStaleAsks(ASK_DEADLINE_MS),
          },
        );

        tick();

        expect(bridge.turn.isProcessing).toBe(true);
        const paths = bridge.turnMarkers().map((marker) => marker.path);
        expect(paths).toContain("infer-start");
        expect(paths).not.toContain("expire-abort");
        expect(paths.some((path) => path.startsWith("stall-abort"))).toBe(
          false,
        );
        expect(wakeDeliveries(port)).toHaveLength(1);
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

        // Stop through the production path, not the clears by hand.
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
        // The aborted wake turn is disarmed with the queue: nothing left to bound.
        expect(bridge.abortStalledWakeTurn()).toBe(false);
      } finally {
        bridge.dispose();
      }
    });
  });

  test("ask deadline pins the production value and its stall-bound sizing", () => {
    expect(ASK_DEADLINE_MS).toBe(1_800_000);
    expect(ASK_DEADLINE_MS).toBe(PROD_STALL_TIMEOUT_MS * 2);
  });
});
