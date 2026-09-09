import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createSubAgentSessionStore } from "../../subagent/session-store.js";
import { createFleetMailbox, createWaitAgentsTool } from "../../subagent/agent-fleet.js";
import { createFleetWakePublisher } from "./wiring.js";
import { attachSessionBridge, type BridgeInboundEvent } from "../runtime-bridge.js";
import { createLiveSessionPort } from "../live-session-port.js";
import { createAppShell } from "../shell/index.js";
import { withTestRenderer } from "../harness.js";
import { resetSessionForRotation } from "./exit.js";
import { clearTranscript } from "../shell/chrome.js";
import { createDeliveryGeneration, createLeftoverSend } from "../queued-delivery.js";
import { createSessionOperationQueue } from "../session-operation-queue.js";

test("failed reset releases publication without flushing partially cancelled workers", () => {
  const store = createSubAgentSessionStore();
  const emitter = new EventEmitter();
  const publisher = createFleetWakePublisher(store, emitter);
  const events: BridgeInboundEvent[] = [];
  emitter.on("event", (event: BridgeInboundEvent) => events.push(event));
  const unsubscribe = store.subscribe(publisher.publish);
  try {
    store.start({ id: "old", agentId: "builder", description: "old", brief: "build" });
    store.markRunning("old");
    store.registerAsk("old", {
      question: "Old question?",
      questionId: "old-question",
      resolve: () => {},
      reject: () => {},
    });
    events.length = 0;
    const error = new Error("reset failed");
    expect(() =>
      publisher.withSuspended(() => {
        store.wake();
        throw error;
      }),
    ).toThrow(error);
    expect(events).toEqual([]);
    publisher.withSuspended(() => store.cancelAll("Session cleared"));
    expect(events).toEqual([
      { type: "agent-ask", asks: [] },
      { type: "fleet", running: 0 },
    ]);
    events.length = 0;
    publisher.withSuspended(() => store.cancelAll("Session cleared"));
    expect(events).toEqual([
      { type: "agent-ask", asks: [] },
      { type: "fleet", running: 0 },
    ]);
  } finally {
    unsubscribe();
  }
});

for (const phase of ["settled", "prequeued", "deferred"] as const) {
  test(`rotation suppresses old worker snapshots (${phase}), including repeated resets`, async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        const store = createSubAgentSessionStore();
        const emitter = new EventEmitter();
        const deliveryGeneration = createDeliveryGeneration();
        const queue = createSessionOperationQueue();
        const sends: string[] = [];
        const scheduled: string[] = [];
        const deliver = createLeftoverSend({
          enqueue: queue.enqueue,
          ingest: async (text, attachments) => ({ text, attachments }),
          send: (text) => {
            sends.push(text);
          },
          captureGeneration: deliveryGeneration.capture,
          onFailure: (error) => {
            throw error;
          },
        });
        const bridge = attachSessionBridge(
          shell,
          createLiveSessionPort({
            send: (text) => {
              sends.push(text);
            },
            deliver: (text) => {
              scheduled.push(text);
              deliver(text);
            },
            interrupt: () => {},
          }),
        );
        let resetting = false;
        const resetEvents: BridgeInboundEvent[] = [];
        const repainted: string[] = [];
        emitter.on("event", (event: BridgeInboundEvent) => {
          bridge.handle(event);
          if (resetting) {
            resetEvents.push(event);
            repainted.push(...shell.streamLog.map((row) => row.text));
          }
        });
        emitter.on("session.clear", () => {
          clearTranscript(shell);
          bridge.clearQueuedDelivery();
        });
        const publisher = createFleetWakePublisher(store, emitter);
        const unsubscribe = store.subscribe(publisher.publish);
        const start = (id: string) => {
          store.start({ id, agentId: "builder", description: id, brief: "build" });
          store.markRunning(id);
          store.registerAsk(id, {
            question: `question ${id}`,
            questionId: `question-${id}`,
            resolve: () => {},
            reject: () => {},
          });
        };
        try {
          for (let round = 0; round < 2; round++) {
            bridge.handle({ type: "inference.start", data: {} });
            start(`old-${round}-one`);
            start(`old-${round}-two`);
            if (phase !== "deferred") bridge.handle({ type: "inference.done", data: {} });
            if (phase === "settled") {
              await queue.awaitTail();
              bridge.handle({ type: "inference.done", data: {} });
            }
            const beforeScheduled = scheduled.length;
            const beforeSent = sends.length;
            resetting = true;
            resetSessionForRotation(
              { withFleetPublicationSuspended: publisher.withSuspended },
              { deliveryGeneration, emitter, subAgentSessions: store },
            );
            resetting = false;
            expect(scheduled).toHaveLength(beforeScheduled);
            expect(repainted).toEqual([]);
            expect(resetEvents).toEqual([
              { type: "agent-ask", asks: [] },
              { type: "fleet", running: 0 },
            ]);
            expect(store.list().every((worker) => worker.status === "cancelled")).toBe(true);
            await queue.awaitTail();
            expect(sends).toHaveLength(beforeSent);
            bridge.handle({ type: "inference.done", data: {} });
            resetEvents.length = 0;
          }
          const before = sends.length;
          start("new-worker");
          await queue.awaitTail();
          expect(sends).toHaveLength(before + 1);
          expect(sends.at(-1)).toContain("question new-worker");
          bridge.handle({ type: "inference.done", data: {} });
          store.wake();
          await queue.awaitTail();
          expect(sends).toHaveLength(before + 1);
        } finally {
          unsubscribe();
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
}

for (const removal of ["answer", "cancel", "terminal", "remove", "replace"] as const) {
  test(`production pending snapshot drops a deferred ask on ${removal}`, async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        const sends: string[] = [];
        const send = (text: string) => {
          sends.push(text);
        };
        const bridge = attachSessionBridge(
          shell,
          createLiveSessionPort({ send, deliver: send, interrupt: () => {} }),
        );
        const store = createSubAgentSessionStore();
        const emitter = new EventEmitter();
        const events: BridgeInboundEvent[] = [];
        emitter.on("event", (event: BridgeInboundEvent) => {
          events.push(event);
          bridge.handle(event);
        });
        const publisher = createFleetWakePublisher(store, emitter);
        const unsubscribe = store.subscribe(publisher.publish);
        try {
          bridge.handle({ type: "inference.start", data: {} });
          const worker = store.start({
            id: "worker-session",
            agentId: "builder",
            description: "work",
            brief: "build",
          });
          store.markRunning(worker.id);
          store.registerAsk(worker.id, {
            question: "Which port?",
            questionId: "q1",
            resolve: () => {},
            reject: () => {},
          });
          if (removal === "answer") {
            const mailbox = createFleetMailbox(store);
            mailbox.register(worker.id);
            const wait = createWaitAgentsTool({ sessions: store, fleetRecords: mailbox });
            if (wait.kind !== "full") throw new Error("expected full wait tool");
            const result = await wait.handler(
              {
                id: "wait-call",
                name: "wait_agents",
                arguments: { targets: [worker.id], timeout_ms: 1000 },
              },
              new AbortController().signal,
            );
            expect(result.content).toContain("awaiting_director");
            store.sendInputOne(worker.id, "8080");
          }
          if (removal === "cancel") store.cancelAsk(worker.id);
          if (removal === "terminal") store.complete(worker.id, "done");
          if (removal === "remove") store.clear();
          if (removal === "replace") {
            store.start({
              id: worker.id,
              agentId: "builder",
              description: "replacement",
              brief: "build",
            });
          }
          expect(events.at(-1)?.type === "fleet" ? events.at(-2) : events.at(-1)).toEqual({
            type: "agent-ask",
            asks: [],
          });
          bridge.handle({ type: "inference.done", data: {} });
          expect(sends).toEqual([]);
        } finally {
          unsubscribe();
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
}

test("same catalog workers answer by session, reconcile one resolution and replacement, exclude nested asks", async () => {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      });
      const sends: string[] = [];
      const send = (text: string) => {
        sends.push(text);
      };
      const bridge = attachSessionBridge(
        shell,
        createLiveSessionPort({ send, deliver: send, interrupt: () => {} }),
      );
      const store = createSubAgentSessionStore();
      const emitter = new EventEmitter();
      emitter.on("event", (event: BridgeInboundEvent) => bridge.handle(event));
      const publisher = createFleetWakePublisher(store, emitter);
      const unsubscribe = store.subscribe(publisher.publish);
      const answers: string[] = [];
      const ask = (id: string, questionId: string) =>
        store.registerAsk(id, {
          question: questionId,
          questionId,
          resolve: (answer) => {
            answers.push(`${id}:${answer}`);
          },
          reject: () => {},
        });
      try {
        bridge.handle({ type: "inference.start", data: {} });
        for (const id of ["session-one", "session-two", "nested"]) {
          store.start({
            id,
            agentId: "builder",
            description: id,
            brief: "build",
            ...(id === "nested" ? { parentSessionId: "session-one" } : {}),
          });
          store.markRunning(id);
          ask(id, `question-${id}`);
        }
        expect(store.sendInputOne("session-one", "8080").ok).toBe(true);
        expect(answers).toEqual(["session-one:8080"]);
        expect(store.hasPendingAsk("session-two")).toBe(true);
        store.cancelAsk("session-two");
        ask("session-two", "replacement-question");
        bridge.handle({ type: "inference.done", data: {} });
        expect(sends).toHaveLength(1);
        expect(sends[0]).toContain("using target session-two");
        expect(sends[0]).toContain("replacement-question");
        expect(sends[0]).not.toContain("question-session-two");
        expect(sends[0]).not.toContain("question-session-one");
        expect(sends[0]).not.toContain("question-nested");
        bridge.handle({ type: "inference.done", data: {} });
        store.wake();
        bridge.handle({ type: "inference.done", data: {} });
        expect(sends).toHaveLength(1);
        expect(store.sendInputOne("session-two", "9090").ok).toBe(true);
        expect(answers).toEqual(["session-one:8080", "session-two:9090"]);
      } finally {
        unsubscribe();
        bridge.dispose();
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
});
