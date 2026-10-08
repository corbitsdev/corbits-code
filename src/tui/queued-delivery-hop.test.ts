/**
 * Last-hop pins for drained queue items: live parent-boundary steers
 * Agent.deliver (deliverSteer); leftover / fleet-hold / interrupt use send.
 */
import { describe, expect, test } from "bun:test";
import { attachSessionBridge, type SessionBridge } from "./runtime-bridge";
import { createLiveSessionPort } from "./live-session-port";
import { createAppShell } from "./shell/index";
import { withTestRenderer } from "./harness";
import {
  badgeCount,
  createLiveSteerDeliver,
  createSessionOperationQueue,
  pause,
  routeQueuedDelivery,
  type AgentDeliveryResult,
  type DeliverySettle,
  type QueueItem,
} from "./delivery-queue.js";

type Shell = ReturnType<typeof createAppShell>;

function lastHopPort(bridgeRef: { current: SessionBridge | undefined }) {
  const sends: string[] = [];
  const steers: string[] = [];
  const port = createLiveSessionPort({
    send: (text) => {
      sends.push(text);
    },
    interrupt: () => undefined,
    deliver: routeQueuedDelivery({
      send: (text) => {
        sends.push(text);
      },
      deliverSteer: (text) => {
        steers.push(text);
      },
      parentCycleLive: () => bridgeRef.current?.parentCycleLive === true,
    }),
  });
  return { port, sends, steers };
}

interface LastHopCtx {
  readonly shell: Shell;
  readonly bridge: SessionBridge;
  readonly sends: string[];
  readonly steers: string[];
}

function withBridge(
  run: "idle" | "busy",
  fn: (ctx: LastHopCtx) => void,
): Promise<void> {
  return withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run,
      });
      const bridgeRef: { current: SessionBridge | undefined } = {
        current: undefined,
      };
      const { port, sends, steers } = lastHopPort(bridgeRef);
      const bridge = attachSessionBridge(shell, port);
      bridgeRef.current = bridge;
      try {
        fn({ shell, bridge, sends, steers });
      } finally {
        bridge.dispose();
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
}

describe("queued delivery last hop", () => {
  test("busy parent tool.boundary steer last-hops to deliverSteer, not send", async () => {
    await withBridge("busy", ({ shell, bridge, sends, steers }) => {
      bridge.submit("asap", "steer");
      expect(badgeCount(shell.session)).toBe(1);
      bridge.handle({ type: "tool.boundary" });
      expect(steers).toEqual(["asap"]);
      expect(sends).toEqual([]);
    });
  });

  test("two live steers at one tool.boundary keep drain order through Agent.deliver", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const bridgeRef: { current: SessionBridge | undefined } = {
          current: undefined,
        };
        const sends: string[] = [];
        const delivered: string[] = [];
        const { enqueue, awaitTail } = createSessionOperationQueue();
        let resolveSlow: () => void = () => undefined;
        const slow = new Promise<void>((resolve) => {
          resolveSlow = resolve;
        });
        const port = createLiveSessionPort({
          send: (text) => {
            sends.push(text);
          },
          interrupt: () => undefined,
          deliver: routeQueuedDelivery({
            send: (text) => {
              sends.push(text);
            },
            deliverSteer: createLiveSteerDeliver({
              enqueue,
              ingest: async (text) => {
                if (text.includes("@mention")) await slow;
                return { text, attachments: [] };
              },
              deliver: (text) => {
                delivered.push(text);
              },
              captureGeneration: () => () => true,
              onFailure: (err) => {
                throw err;
              },
            }),
            parentCycleLive: () => bridgeRef.current?.parentCycleLive === true,
          }),
        });
        const bridge = attachSessionBridge(shell, port);
        bridgeRef.current = bridge;
        try {
          bridge.submit("@mention first", "steer");
          bridge.submit("plain second", "steer");
          expect(badgeCount(shell.session)).toBe(2);
          bridge.handle({ type: "tool.boundary" });
          await Promise.resolve();
          await Promise.resolve();
          expect(delivered).toEqual([]);
          resolveSlow();
          await awaitTail();
          expect(delivered).toEqual(["@mention first", "plain second"]);
          expect(sends).toEqual([]);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("inference.done with outstanding tools last-hops to deliverSteer, not send", async () => {
    await withBridge("busy", ({ shell, bridge, sends, steers }) => {
      bridge.submit("asap", "steer");
      expect(badgeCount(shell.session)).toBe(1);
      bridge.handle({
        type: "tool.start",
        data: { call: { id: "c1", name: "run_shell" } },
      });
      bridge.handle({ type: "inference.done", data: {} });
      expect(steers).toEqual(["asap"]);
      expect(sends).toEqual([]);
    });
  });

  test("text-only settle leftover steer last-hops to send", async () => {
    await withBridge("busy", ({ bridge, sends, steers }) => {
      bridge.submit("leftover", "steer");
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({
        type: "inference.text.delta",
        data: { token: "hi" },
      });
      bridge.handle({ type: "inference.done", data: {} });
      expect(sends).toEqual(["leftover"]);
      expect(steers).toEqual([]);
    });
  });

  test("interrupt leftover steer is held under pause until an explicit new send", async () => {
    await withBridge("busy", ({ shell, bridge, sends, steers }) => {
      // A steer the operator queued while the run was busy.
      bridge.submit("after stop", "steer");
      // Operator Ctrl+C pauses (Phase 4 sets the flag; the gate here honors an
      // already-paused state) then stops and interrupts the run.
      shell.session = pause(shell.session);
      bridge.interrupt();
      // Paused: the leftover steer must NOT deliver to the rebuilt agent.
      expect(sends).toEqual([]);
      expect(steers).toEqual([]);
      expect(badgeCount(shell.session)).toBe(1);
      // An explicit new send clears the pause (the submit path resumes the
      // session) and the boundary drains the held steer onto the fresh turn.
      bridge.submit("fresh prompt", "immediate");
      bridge.handle({ type: "run", state: "idle" });
      expect(sends).toEqual(["fresh prompt", "after stop"]);
      expect(steers).toEqual([]);
      expect(badgeCount(shell.session)).toBe(0);
    });
  });

  test("held follow-up delivers at the boundary only after an explicit new send", async () => {
    await withBridge("busy", ({ shell, bridge, sends, steers }) => {
      bridge.submit("held follow-up", "queue");
      expect(badgeCount(shell.session)).toBe(1);
      // Operator Ctrl+C pauses and stops the run.
      shell.session = pause(shell.session);
      bridge.interrupt();
      // Paused: nothing drains at the interrupt/following boundaries.
      bridge.handle({ type: "run", state: "idle" });
      expect(sends).toEqual([]);
      expect(steers).toEqual([]);
      expect(badgeCount(shell.session)).toBe(1);
      // Explicit new send clears the pause (submit path resumes the session)
      // and starts a fresh turn.
      bridge.submit("fresh prompt", "immediate");
      // Now the boundary delivers both the new send and the held follow-up.
      bridge.handle({ type: "run", state: "idle" });
      expect(sends).toEqual(["fresh prompt", "held follow-up"]);
      expect(badgeCount(shell.session)).toBe(0);
    });
  });

  test("idle-with-fleet leftover steer last-hops to send", async () => {
    await withBridge("idle", ({ bridge, sends, steers }) => {
      bridge.submit("dispatch", "immediate");
      bridge.submit("one more worker", "steer");
      bridge.handle({ type: "fleet", running: 1 });
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({ type: "inference.done", data: {} });
      expect(sends).toEqual(["dispatch", "one more worker"]);
      expect(steers).toEqual([]);
    });
  });

  test("/clear drops queued steers so a later boundary does not deliver or send", async () => {
    await withBridge("busy", ({ shell, bridge, sends, steers }) => {
      bridge.submit("old steer", "steer");
      expect(badgeCount(shell.session)).toBe(1);
      bridge.clearQueuedDelivery();
      bridge.handle({ type: "tool.boundary" });
      expect(sends).toEqual([]);
      expect(steers).toEqual([]);
    });
  });
});

function makeRecoveryPort(results: AgentDeliveryResult[]) {
  const calls: { item: QueueItem; settle: DeliverySettle | undefined }[] = [];
  const sentImmediate: string[] = [];
  const port = {
    sendImmediate: (text: string) => {
      sentImmediate.push(text);
    },
    deliver: (item: QueueItem, settle?: DeliverySettle) => {
      calls.push({ item, settle });
      const next = results.shift();
      if (next !== undefined) settle?.(next);
    },
  };
  return { port, calls, sentImmediate };
}

const CLOSED_RESULT: AgentDeliveryResult = {
  status: "not-delivered",
  reason: "agent-closed",
  detail: "agent is closed",
};

function drainedUserRow(shell: { streamLog: readonly unknown[] }): {
  queueItemId?: string;
  meta?: string;
  deliveryStatus?: string;
} {
  // The enqueue-time tag row and the dispatched row share the queueItemId;
  // the dispatched row is the one handed to the run.
  const rows = shell.streamLog.filter(
    (candidate): candidate is { queueItemId?: string } =>
      typeof candidate === "object" &&
      candidate !== null &&
      "queueItemId" in candidate,
  );
  const row = rows.at(-1);
  if (row === undefined) throw new Error("expected a drained queue row");
  return row as {
    queueItemId?: string;
    meta?: string;
    deliveryStatus?: string;
  };
}

function recoveryNotices(shell: {
  streamLog: readonly { role: string; text: string }[];
}): string[] {
  return shell.streamLog
    .filter((row) => row.role === "system")
    .map((row) => row.text)
    .filter(
      (text) => text.includes("not delivered") || text.includes("uncertain"),
    );
}

interface RecoveryCtx {
  readonly shell: Shell;
  readonly bridge: SessionBridge;
  readonly calls: { item: QueueItem; settle: DeliverySettle | undefined }[];
  readonly sentImmediate: string[];
}

function withRecoveryBridge(
  results: AgentDeliveryResult[],
  fn: (ctx: RecoveryCtx) => void,
): Promise<void> {
  return withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "busy",
      });
      const { port, calls, sentImmediate } = makeRecoveryPort(results);
      const bridge = attachSessionBridge(shell, port);
      try {
        fn({ shell, bridge, calls, sentImmediate });
      } finally {
        bridge.dispose();
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
}

describe("closed-target recovery", () => {
  test("agent-closed restores the exact message to an empty prompt and corrects the row", async () => {
    await withRecoveryBridge([CLOSED_RESULT], ({ shell, bridge, calls }) => {
      bridge.submit("steer the ship", "steer", [
        {
          id: "shot-1",
          name: "shot.png",
          contentType: "image/png",
          data: new Uint8Array([1]),
          contentHash: "hash-shot",
        },
      ]);
      bridge.handle({ type: "tool.boundary" });
      expect(calls).toHaveLength(1);

      // Ownership returns to the composer with the exact payload intact.
      expect(shell.prompt.value).toBe("steer the ship");
      expect(
        shell.pendingAttachments.map((attachment) => attachment.id),
      ).toEqual(["shot-1"]);

      // The row painted as delivered now reads as not delivered.
      const row = drainedUserRow(shell);
      expect(row.meta).toBe("not-delivered");
      expect(row.deliveryStatus).toBe("not-delivered");

      // Actionable copy states the delivery status and recovery location.
      const notices = recoveryNotices(shell);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("not delivered");
      expect(notices[0]).toContain("prompt");

      // The popped item cannot redispatch at a later boundary.
      bridge.handle({ type: "tool.boundary" });
      expect(calls).toHaveLength(1);
    });
  });

  test("agent-closed with a draft in the composer defers recovery behind it", async () => {
    await withRecoveryBridge(
      [CLOSED_RESULT],
      ({ shell, bridge, calls, sentImmediate }) => {
        bridge.submit("steer the ship", "steer");
        shell.prompt.value = "draft in progress";
        bridge.handle({ type: "tool.boundary" });
        expect(calls).toHaveLength(1);

        // The operator's draft is untouched; the notice says where the
        // failed message went.
        expect(shell.prompt.value).toBe("draft in progress");
        const notices = recoveryNotices(shell);
        expect(notices).toHaveLength(1);
        // the notice says the operator's draft survived untouched
        expect(notices[0]).toContain("draft");

        // Sending the draft returns the failed message to the prompt; the
        // Enter handler clears the composer before submit, so model that
        // here.
        shell.prompt.value = "";
        bridge.submit("draft in progress", "immediate");
        expect(sentImmediate).toEqual(["draft in progress"]);
        expect(shell.prompt.value).toBe("steer the ship");
        expect(calls).toHaveLength(1);
      },
    );
  });

  test("uncertain delivery marks the row without claiming nondelivery", async () => {
    await withRecoveryBridge(
      [{ status: "uncertain", detail: "connection reset" }],
      ({ shell, bridge, calls }) => {
        bridge.submit("steer the ship", "steer");
        bridge.handle({ type: "tool.boundary" });
        expect(calls).toHaveLength(1);

        const row = drainedUserRow(shell);
        expect(row.meta).toBe("delivery-uncertain");
        expect(row.deliveryStatus).toBe("uncertain");

        // Content is still preserved even though delivery is unknown.
        expect(shell.prompt.value).toBe("steer the ship");

        const notices = recoveryNotices(shell);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain("uncertain");
      },
    );
  });

  test("accepted delivery leaves the prompt and transcript alone", async () => {
    await withRecoveryBridge(
      [{ status: "accepted" }],
      ({ shell, bridge, calls }) => {
        bridge.submit("steer the ship", "steer");
        bridge.handle({ type: "tool.boundary" });
        expect(calls).toHaveLength(1);

        expect(shell.prompt.value).toBe("");
        // The pending column carried the item until delivery, so the
        // transcript row is a plain operator message — no [steering] label.
        const row = drainedUserRow(shell);
        expect(row.meta).toBeUndefined();
        expect(shell.streamLog.map((r) => r.text).join("\n")).toContain(
          "steer the ship",
        );
        expect(recoveryNotices(shell)).toEqual([]);
      },
    );
  });

  test("a second settle for the same item is dropped, never resent", async () => {
    await withRecoveryBridge([], ({ shell, bridge, calls }) => {
      bridge.submit("steer the ship", "steer");
      bridge.handle({ type: "tool.boundary" });
      expect(calls).toHaveLength(1);

      const settle = calls[0]?.settle;
      if (settle === undefined) throw new Error("expected a settle callback");
      settle(CLOSED_RESULT);
      settle(CLOSED_RESULT);

      expect(calls).toHaveLength(1);
      expect(shell.prompt.value).toBe("steer the ship");
      expect(recoveryNotices(shell)).toHaveLength(1);
    });
  });
});
