import { describe, expect, test } from "bun:test";
import { attachSessionBridge } from "./runtime-bridge";
import { createLiveSessionPort } from "./live-session-port";
import { createAppShell } from "./shell/index";
import { withTestRenderer } from "./harness";
import type { PendingAskWake } from "../subagent/fleet-report.js";
import { classifySubmission, createSubmitHandler } from "./runner/submit.js";
import {
  createDeliveryGeneration,
  createLeftoverSend,
  routeQueuedDelivery,
} from "./queued-delivery.js";
import { createSessionOperationQueue } from "./session-operation-queue.js";
import { ingestOperatorPrompt } from "./prompt-attachments.js";
import {
  armFeedbackCapture,
  cancelFeedbackCapture,
  isFeedbackCapturePending,
  resetFeedbackStateForTests,
} from "../telemetry/feedback.js";

function wake(id: string, questionId: string): PendingAskWake {
  return {
    sessionId: id,
    agentId: "builder",
    description: `worker ${id}`,
    question: "Which port?",
    questionId,
  };
}

async function withWakeBridge(
  run: (bridge: ReturnType<typeof attachSessionBridge>, sends: string[]) => void,
) {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      });
      const sends: string[] = [];
      const send = (text: string) => {
        sends.push(text);
      };
      const bridge = attachSessionBridge(
        shell,
        createLiveSessionPort({ send, deliver: send, interrupt: () => undefined }),
      );
      try {
        run(bridge, sends);
      } finally {
        bridge.dispose();
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
}

for (const action of ["retry", "interrupt", "reset", "dispose", "composer", "ordinary"] as const) {
  test(`quota replay preserves submission origin (${action})`, async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const sends: string[] = [];
        const composerSends: string[] = [];
        const feedback: string[] = [];
        let cancellations = 0;
        let nowMs = 0;
        let tick: () => void = () => undefined;
        const submit = createSubmitHandler({
          dispatchCommand: () => undefined,
          sendPrompt: (text) => {
            composerSends.push(text);
            sends.push(text);
          },
          isFeedbackCapturePending,
          onFeedbackText: (text) => {
            feedback.push(text);
            cancelFeedbackCapture();
            return "Thanks";
          },
          cancelFeedbackCapture: () => {
            cancellations++;
            cancelFeedbackCapture();
          },
        });
        const port = createLiveSessionPort({
          send: submit,
          classifySubmit: (text) =>
            classifySubmission(text, {
              feedbackPending: isFeedbackCapturePending(),
              feedbackCaptureEnabled: true,
            }),
          interrupt: () => undefined,
          deliver: routeQueuedDelivery({
            send: (text) => {
              sends.push(text);
            },
            deliverSteer: () => {
              throw new Error("quota replay must not live-inject");
            },
            parentCycleLive: () => bridge.parentCycleLive,
          }),
        });
        const bridge = attachSessionBridge(shell, port, {
          now: () => nowMs,
          schedule: (fn) => {
            tick = fn;
            // Retain the callback to exercise even a stale timer after disposal.
            return () => undefined;
          },
        });
        try {
          if (action === "ordinary") {
            bridge.submit("operator prompt", "immediate");
          } else {
            bridge.handle({ type: "inference.start", data: {} });
            bridge.handle({ type: "fleet", running: 1 });
            bridge.submit("held first", "queue");
            bridge.submit("held second", "queue");
            bridge.handle({ type: "inference.done", data: {} });
            if (action !== "composer") armFeedbackCapture();
            bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
            if (action === "composer") bridge.submit("operator prompt", "immediate");
          }
          const queued = shell.session.items;
          const before = sends.length;
          const replay = sends.at(-1);
          bridge.handle({
            type: "inference.error",
            data: { error: { category: "quota_exhausted", retryAfterMs: 1000 } },
          });
          if (action === "interrupt") bridge.interrupt();
          if (action === "reset") bridge.clearQueuedDelivery();
          if (action === "dispose") bridge.dispose();
          const afterCleanup = sends.length;
          nowMs = 999;
          tick();
          expect(sends).toHaveLength(afterCleanup);
          nowMs = 1000;
          tick();
          tick();
          if (action === "interrupt" || action === "reset" || action === "dispose") {
            expect(sends).toHaveLength(afterCleanup);
            expect(feedback).toEqual([]);
          } else {
            expect(sends).toHaveLength(before + 1);
            expect(sends.at(-1)).toBe(replay);
            expect(shell.session.items).toBe(queued);
            if (action === "retry") {
              expect(sends[0]).toBe(sends[1]);
              expect(composerSends).toEqual([]);
              expect(feedback).toEqual([]);
              expect(cancellations).toBe(0);
              expect(isFeedbackCapturePending()).toBe(true);
              expect(queued.map((item) => item.text)).toEqual(["held first", "held second"]);
              bridge.submit("actual feedback", "immediate");
              expect(feedback).toEqual(["actual feedback"]);
              expect(sends).toHaveLength(2);
            } else {
              expect(composerSends).toEqual(["operator prompt", "operator prompt"]);
            }
          }
        } finally {
          resetFeedbackStateForTests();
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
}

describe("agent ask wake delivery", () => {
  test("synthetic wake bypasses armed feedback and leaves user followups held", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        const sends: string[] = [];
        const feedback: string[] = [];
        let cancellations = 0;
        const submit = createSubmitHandler({
          dispatchCommand: () => undefined,
          sendPrompt: (text) => {
            sends.push(text);
          },
          isFeedbackCapturePending,
          onFeedbackText: (text) => {
            feedback.push(text);
            cancelFeedbackCapture();
            return "Thanks";
          },
          cancelFeedbackCapture: () => {
            cancellations++;
            cancelFeedbackCapture();
          },
        });
        const port = createLiveSessionPort({
          send: submit,
          classifySubmit: (text) =>
            classifySubmission(text, {
              feedbackPending: isFeedbackCapturePending(),
              feedbackCaptureEnabled: true,
            }),
          interrupt: () => undefined,
          deliver: routeQueuedDelivery({
            send: (text) => {
              sends.push(text);
              // Real delivery can synchronously settle and notify the bridge again.
              bridge.handle({ type: "inference.done", data: {} });
              bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
            },
            deliverSteer: () => {
              throw new Error("wake must not live-inject");
            },
            parentCycleLive: () => bridge.parentCycleLive,
          }),
        });
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.handle({ type: "inference.start", data: {} });
          bridge.handle({ type: "fleet", running: 1 });
          bridge.submit("held followup", "queue");
          bridge.handle({ type: "inference.done", data: {} });
          const held = shell.session;
          armFeedbackCapture();
          bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
          expect(sends).toHaveLength(1);
          expect(sends[0]).toContain("q1");
          expect(feedback).toEqual([]);
          expect(cancellations).toBe(0);
          expect(isFeedbackCapturePending()).toBe(true);
          expect(shell.session.items).toEqual(held.items);
          expect(held.items).toHaveLength(1);
          expect(bridge.turn.isProcessing).toBe(false);
          bridge.submit("actual feedback", "immediate");
          expect(feedback).toEqual(["actual feedback"]);
          expect(sends).toHaveLength(1);
        } finally {
          resetFeedbackStateForTests();
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("resolved snapshots remove deferred questions", async () => {
    await withWakeBridge((bridge, sends) => {
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
      bridge.handle({ type: "agent-ask", asks: [] });
      bridge.handle({ type: "inference.done", data: {} });
      expect(sends).toEqual([]);
    });
  });

  test("final worker gate closes over an idle parent fleet hold", async () => {
    await withWakeBridge((bridge, sends) => {
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({ type: "fleet", running: 2 });
      bridge.handle({ type: "inference.done", data: {} });
      bridge.gateOpened();
      bridge.gateOpened();
      bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
      bridge.gateClosed();
      expect(sends).toEqual([]);
      bridge.gateClosed();
      expect(sends).toHaveLength(1);
      bridge.handle({ type: "inference.done", data: {} });
      bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
      bridge.handle({ type: "inference.done", data: {} });
      expect(sends).toHaveLength(1);
    });
  });

  for (const settleFirst of [false, true]) {
    test(`live parent and two gates wait for both conditions (settle first: ${settleFirst})`, async () => {
      await withWakeBridge((bridge, sends) => {
        bridge.gateOpened();
        bridge.handle({ type: "inference.start", data: {} });
        bridge.handle({ type: "fleet", running: 1 });
        bridge.gateOpened();
        bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
        bridge.gateClosed();
        if (settleFirst) bridge.handle({ type: "inference.done", data: {} });
        expect(sends).toEqual([]);
        bridge.gateClosed();
        if (!settleFirst) {
          expect(sends).toEqual([]);
          expect(bridge.turn.isProcessing).toBe(true);
          bridge.handle({ type: "inference.done", data: {} });
        }
        expect(sends).toHaveLength(1);
      });
    });
  }

  test("a parked ask wakes an idle parent exactly once, including notifications after settle", async () => {
    await withWakeBridge((bridge, sends) => {
      bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
      expect(sends).toHaveLength(1);
      expect(sends[0]).toContain("a1");
      expect(sends[0]).toContain("Which port?");
      expect(sends[0]).toContain("q1");
      expect(sends[0]).toContain("send_input");
      bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
      bridge.handle({ type: "inference.done", data: {} });
      bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
      expect(sends).toHaveLength(1);
      bridge.handle({ type: "agent-ask", asks: [] });
      expect(sends).toHaveLength(1);
    });
  });

  test("an ask parking mid-cycle defers to settle, then flushes once", async () => {
    await withWakeBridge((bridge, sends) => {
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
      expect(sends).toEqual([]);
      bridge.handle({ type: "inference.done", data: {} });
      expect(sends).toHaveLength(1);
    });
  });

  test("multiple parked asks coalesce into one wake message", async () => {
    await withWakeBridge((bridge, sends) => {
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
      bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1"), wake("a2", "q2")] });
      bridge.handle({ type: "inference.done", data: {} });
      expect(sends).toHaveLength(1);
      expect(sends[0]).toContain("a1");
      expect(sends[0]).toContain("a2");
    });
  });

  test("an open gate defers the wake; gate close flushes once", async () => {
    await withWakeBridge((bridge, sends) => {
      bridge.gateOpened();
      bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
      expect(sends).toEqual([]);
      bridge.gateClosed();
      expect(sends).toHaveLength(1);
    });
  });

  test("clearQueuedDelivery drops stashed wakes and resets delivered identities", async () => {
    await withWakeBridge((bridge, sends) => {
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
      bridge.clearQueuedDelivery();
      bridge.handle({ type: "inference.done", data: {} });
      expect(sends).toEqual([]);
      bridge.handle({ type: "agent-ask", asks: [wake("a2", "q2")] });
      expect(sends).toHaveLength(1);
      bridge.clearQueuedDelivery();
      bridge.handle({ type: "inference.done", data: {} });
      expect(sends).toHaveLength(1);
      bridge.handle({ type: "agent-ask", asks: [wake("a2", "q2")] });
      expect(sends).toHaveLength(2);
    });
  });

  test("disposed bridges cannot revive deferred wakes", async () => {
    await withWakeBridge((bridge, sends) => {
      bridge.gateOpened();
      bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
      bridge.dispose();
      bridge.gateClosed();
      bridge.handle({ type: "inference.done", data: {} });
      bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
      expect(sends).toEqual([]);
    });
  });

  for (const stop of ["interrupt", "stall abort"] as const) {
    test(`${stop} flushes a stashed ask once the parent is idle`, async () => {
      await withTestRenderer(
        async (h) => {
          const shell = createAppShell(h.renderer, {
            terminal: { columns: 80, rows: 24 },
            wireKeys: false,
            run: "idle",
          });
          const sends: string[] = [];
          let nowMs = 0;
          let tick: () => void = () => undefined;
          const bridge = attachSessionBridge(
            shell,
            createLiveSessionPort({
              send: (text) => {
                sends.push(text);
              },
              deliver: (text) => {
                sends.push(text);
              },
              interrupt: () => undefined,
            }),
            {
              now: () => nowMs,
              stallTimeoutMs: 1_000,
              stallNoticeMs: 400,
              schedule: (fn) => {
                tick = fn;
                return () => undefined;
              },
            },
          );
          try {
            bridge.handle({ type: "inference.start", data: {} });
            bridge.handle({ type: "inference.text.delta", data: { token: "ok" } });
            bridge.handle({ type: "agent-ask", asks: [wake("a1", "q1")] });
            expect(sends).toEqual([]);
            if (stop === "interrupt") {
              bridge.interrupt();
            } else {
              nowMs = 1_000;
              tick();
            }
            expect(sends).toHaveLength(1);
            expect(sends[0]).toContain("q1");
            expect(bridge.turn.isProcessing).toBe(true);
          } finally {
            bridge.dispose();
            shell.dispose();
          }
        },
        { width: 80, height: 24 },
      );
    });
  }

  test("a wake question with bracket lines does not spoof attachment-echo matching", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const sends: string[] = [];
        const send = (text: string) => {
          sends.push(text);
        };
        const bridge = attachSessionBridge(
          shell,
          createLiveSessionPort({ send, deliver: send, interrupt: () => undefined }),
        );
        try {
          const ask = {
            ...wake("a1", "q1"),
            question: "Choose:\n[1] 8080\n[2] 9090",
          };
          bridge.handle({ type: "agent-ask", asks: [ask] });
          expect(sends).toHaveLength(1);
          const wakeText = sends[0];
          if (wakeText === undefined) throw new Error("expected wake text");
          bridge.handle({
            type: "message.received",
            data: { message: { content: wakeText } },
          });
          expect(shell.streamLog.filter((row) => row.role === "user")).toHaveLength(1);
          bridge.submit("hello", "immediate");
          bridge.handle({
            type: "message.received",
            data: { message: { content: "hello\n[1 image attached: shot.png]" } },
          });
          expect(
            shell.streamLog.filter((row) => row.role === "user").map((row) => row.text),
          ).toEqual([wakeText, "hello"]);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("idle leftover wake keeps an @path in the question raw and consumes the echo", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const sent: string[] = [];
        const attachments: number[] = [];
        const ingested: string[] = [];
        const queue = createSessionOperationQueue();
        const leftoverSend = createLeftoverSend({
          enqueue: queue.enqueue,
          ingest: async (text, pending) => {
            ingested.push(text);
            return ingestOperatorPrompt(
              text,
              "/repo",
              async () => {
                throw new Error("wake leftover must not load image paths");
              },
              pending,
            );
          },
          send: (text, pending) => {
            sent.push(text);
            attachments.push(pending.length);
          },
          captureGeneration: createDeliveryGeneration().capture,
          onFailure: (error) => {
            throw error;
          },
        });
        const send = (text: string) => {
          leftoverSend(text);
        };
        const bridge = attachSessionBridge(
          shell,
          createLiveSessionPort({
            send,
            deliver: routeQueuedDelivery({
              send,
              deliverSteer: () => {
                throw new Error("wake must not live-inject");
              },
              parentCycleLive: () => bridge.parentCycleLive,
            }),
            interrupt: () => undefined,
          }),
        );
        try {
          const ask = {
            ...wake("a1", "q1"),
            question: "Should I edit @src/foo.ts?",
          };
          bridge.handle({ type: "agent-ask", asks: [ask] });
          await queue.awaitTail();
          expect(sent).toHaveLength(1);
          const wakeText = sent[0];
          if (wakeText === undefined) throw new Error("expected wake text");
          expect(wakeText).toContain("@src/foo.ts");
          expect(wakeText).not.toContain("(not found)");
          expect(attachments).toEqual([0]);
          expect(ingested).toEqual([]);
          expect(shell.streamLog.filter((row) => row.role === "user")).toHaveLength(1);
          bridge.handle({
            type: "message.received",
            data: { message: { content: wakeText } },
          });
          expect(shell.streamLog.filter((row) => row.role === "user")).toHaveLength(1);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});
