/**
 * Bridge-side delivery of ask_director parent-wakes: stash while the parent
 * turn is live or gated, coalesce, flush exactly once at settle or gate
 * close, and drop the stash on session rotation. The pure emitter-side diff
 * (which asks deserve a wake) lives in subagent/fleet-report.ask-wake.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { attachSessionBridge } from "./runtime-bridge";
import { createLiveSessionPort } from "./live-session-port";
import { createAppShell } from "./shell/index";
import { withTestRenderer } from "./harness";
import type { PendingAskWake } from "../subagent/fleet-report.js";

function wake(id: string, questionId: string): PendingAskWake {
  return {
    sessionId: id,
    agentId: id,
    description: `worker ${id}`,
    question: "Which port?",
    questionId,
  };
}

function capturePort() {
  const sends: string[] = [];
  const port = createLiveSessionPort({
    send: (text) => {
      sends.push(text);
    },
    interrupt: () => {},
    deliver: () => {},
  });
  return { port, sends };
}

describe("agent ask wake delivery", () => {
  test("a parked ask wakes an idle parent exactly once, repeats dedup", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const { port, sends } = capturePort();
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
          expect(sends).toHaveLength(1);
          expect(sends[0]).toContain("a1");
          expect(sends[0]).toContain("Which port?");
          expect(sends[0]).toContain("q1");
          expect(sends[0]).toContain("send_input");

          // Repeat store notification for the same question: no second send.
          bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
          expect(sends).toHaveLength(1);

          // A resolved ask emits no wake event; an empty list must not send.
          bridge.handle({ type: "agent-ask", asks: [] });
          expect(sends).toHaveLength(1);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("an ask parking mid-cycle defers to settle, then flushes once", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const { port, sends } = capturePort();
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.handle({ type: "run", state: "busy" });
          bridge.handle({ type: "inference.start", data: {} });
          bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
          expect(sends).toEqual([]);

          bridge.handle({ type: "inference.done", data: {} });
          expect(sends).toHaveLength(1);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("multiple parked asks coalesce into one wake message", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const { port, sends } = capturePort();
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.handle({ type: "run", state: "busy" });
          bridge.handle({ type: "inference.start", data: {} });
          bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
          bridge.handle({ type: "agent-ask", asks: [wake("a2", "q2")] });
          bridge.handle({ type: "inference.done", data: {} });
          expect(sends).toHaveLength(1);
          expect(sends[0]).toContain("a1");
          expect(sends[0]).toContain("a2");
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("an open gate defers the wake; gate close flushes once", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const { port, sends } = capturePort();
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.gateOpened();
          bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
          expect(sends).toEqual([]);

          bridge.gateClosed();
          expect(sends).toHaveLength(1);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("clearQueuedDelivery drops stashed wakes", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const { port, sends } = capturePort();
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.handle({ type: "run", state: "busy" });
          bridge.handle({ type: "inference.start", data: {} });
          bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
          bridge.clearQueuedDelivery();
          bridge.handle({ type: "inference.done", data: {} });
          expect(sends).toEqual([]);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});
