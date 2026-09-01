/**
 * Last-hop pins for drained queue items: live parent-boundary steers
 * Agent.deliver (deliverSteer); leftover / fleet-hold / interrupt use send.
 */
import { describe, expect, test } from "bun:test";
import { attachSessionBridge, type SessionBridge } from "./runtime-bridge";
import { createLiveSessionPort } from "./live-session-port";
import { createAppShell } from "./shell";
import { withTestRenderer } from "./harness";
import { routeQueuedDelivery } from "./queued-delivery.js";
import { badgeCount } from "./session-queue";

function lastHopPort(bridgeRef: { current: SessionBridge | undefined }) {
  const sends: string[] = [];
  const steers: string[] = [];
  const port = createLiveSessionPort({
    send: (text) => {
      sends.push(text);
    },
    interrupt: () => {},
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
        const bridgeRef: { current: SessionBridge | undefined } = { current: undefined };
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

  test("text-only settle leftover steer last-hops to send", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const bridgeRef: { current: SessionBridge | undefined } = { current: undefined };
        const { port, sends, steers } = lastHopPort(bridgeRef);
        const bridge = attachSessionBridge(shell, port);
        bridgeRef.current = bridge;
        try {
          bridge.submit("leftover", "steer");
          bridge.handle({ type: "inference.start", data: {} });
          bridge.handle({ type: "inference.text.delta", data: { token: "hi" } });
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
        const bridgeRef: { current: SessionBridge | undefined } = { current: undefined };
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
        const bridgeRef: { current: SessionBridge | undefined } = { current: undefined };
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
        const bridgeRef: { current: SessionBridge | undefined } = { current: undefined };
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
