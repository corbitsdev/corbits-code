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
  createLiveSteerDeliver,
  routeQueuedDelivery,
  type DeliverySettle,
} from "./queued-delivery.js";
import { createSessionOperationQueue } from "./session-operation-queue.js";
import { badgeCount, type QueueItem } from "./session-queue";
import type { AgentDeliveryResult } from "./deliver-agent-message.js";

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

describe("queued delivery last hop", () => {
  test("busy parent tool.boundary steer last-hops to deliverSteer, not send", async () => {
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
        const { port, sends, steers } = lastHopPort(bridgeRef);
        const bridge = attachSessionBridge(shell, port);
        bridgeRef.current = bridge;
        try {
          bridge.submit("asap", "steer");
          expect(badgeCount(shell.session)).toBe(1);
          bridge.handle({ type: "tool.boundary" });
          expect(steers).toEqual(["asap"]);
          expect(sends).toEqual([]);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
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
        const { port, sends, steers } = lastHopPort(bridgeRef);
        const bridge = attachSessionBridge(shell, port);
        bridgeRef.current = bridge;
        try {
          bridge.submit("asap", "steer");
          expect(badgeCount(shell.session)).toBe(1);
          bridge.handle({
            type: "tool.start",
            data: { call: { id: "c1", name: "run_shell" } },
          });
          bridge.handle({ type: "inference.done", data: {} });
          expect(steers).toEqual(["asap"]);
          expect(sends).toEqual([]);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("text-only settle leftover steer last-hops to send", async () => {
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
        const { port, sends, steers } = lastHopPort(bridgeRef);
        const bridge = attachSessionBridge(shell, port);
        bridgeRef.current = bridge;
        try {
          bridge.submit("leftover", "steer");
          bridge.handle({ type: "inference.start", data: {} });
          bridge.handle({
            type: "inference.text.delta",
            data: { token: "hi" },
          });
          bridge.handle({ type: "inference.done", data: {} });
          expect(sends).toEqual(["leftover"]);
          expect(steers).toEqual([]);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("interrupt leftover steer last-hops to send", async () => {
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
        const { port, sends, steers } = lastHopPort(bridgeRef);
        const bridge = attachSessionBridge(shell, port);
        bridgeRef.current = bridge;
        try {
          bridge.submit("after stop", "steer");
          bridge.interrupt();
          expect(sends).toEqual(["after stop"]);
          expect(steers).toEqual([]);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("idle-with-fleet leftover steer last-hops to send", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const bridgeRef: { current: SessionBridge | undefined } = {
          current: undefined,
        };
        const { port, sends, steers } = lastHopPort(bridgeRef);
        const bridge = attachSessionBridge(shell, port);
        bridgeRef.current = bridge;
        try {
          bridge.submit("dispatch", "immediate");
          bridge.submit("one more worker", "steer");
          bridge.handle({ type: "fleet", running: 1 });
          bridge.handle({ type: "inference.start", data: {} });
          bridge.handle({ type: "inference.done", data: {} });
          expect(sends).toEqual(["dispatch", "one more worker"]);
          expect(steers).toEqual([]);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("/clear drops queued steers so a later boundary does not deliver or send", async () => {
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
        const { port, sends, steers } = lastHopPort(bridgeRef);
        const bridge = attachSessionBridge(shell, port);
        bridgeRef.current = bridge;
        try {
          bridge.submit("old steer", "steer");
          expect(badgeCount(shell.session)).toBe(1);
          bridge.clearQueuedDelivery();
          bridge.handle({ type: "tool.boundary" });
          expect(sends).toEqual([]);
          expect(steers).toEqual([]);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
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

describe("closed-target recovery", () => {
  test("agent-closed restores the exact message to an empty prompt and corrects the row", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const { port, calls } = makeRecoveryPort([CLOSED_RESULT]);
        const bridge = attachSessionBridge(shell, port);
        try {
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
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("agent-closed with a draft in the composer defers recovery behind it", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const { port, calls, sentImmediate } = makeRecoveryPort([
          CLOSED_RESULT,
        ]);
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.submit("steer the ship", "steer");
          shell.prompt.value = "draft in progress";
          bridge.handle({ type: "tool.boundary" });
          expect(calls).toHaveLength(1);

          // The operator's draft is untouched; the notice says where the
          // failed message went.
          expect(shell.prompt.value).toBe("draft in progress");
          const notices = recoveryNotices(shell);
          expect(notices).toHaveLength(1);
          expect(notices[0]).toContain("draft is unchanged");

          // Sending the draft returns the failed message to the prompt. The
          // Enter handler clears the composer before submit; model that here.
          shell.prompt.value = "";
          bridge.submit("draft in progress", "immediate");
          expect(sentImmediate).toEqual(["draft in progress"]);
          expect(shell.prompt.value).toBe("steer the ship");
          expect(calls).toHaveLength(1);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("uncertain delivery marks the row without claiming nondelivery", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const { port, calls } = makeRecoveryPort([
          { status: "uncertain", detail: "connection reset" },
        ]);
        const bridge = attachSessionBridge(shell, port);
        try {
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
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("accepted delivery leaves the prompt and transcript alone", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const { port, calls } = makeRecoveryPort([{ status: "accepted" }]);
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.submit("steer the ship", "steer");
          bridge.handle({ type: "tool.boundary" });
          expect(calls).toHaveLength(1);

          expect(shell.prompt.value).toBe("");
          expect(drainedUserRow(shell).meta).toBe("steering");
          expect(recoveryNotices(shell)).toEqual([]);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("a second settle for the same item is dropped, never resent", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const { port, calls } = makeRecoveryPort([]);
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.submit("steer the ship", "steer");
          bridge.handle({ type: "tool.boundary" });
          expect(calls).toHaveLength(1);

          const settle = calls[0]?.settle;
          if (settle === undefined)
            throw new Error("expected a settle callback");
          settle(CLOSED_RESULT);
          settle(CLOSED_RESULT);

          expect(calls).toHaveLength(1);
          expect(shell.prompt.value).toBe("steer the ship");
          expect(recoveryNotices(shell)).toHaveLength(1);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});
