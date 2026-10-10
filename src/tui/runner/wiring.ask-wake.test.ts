import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createSubAgentSessionStore } from "../../subagent/session-store.js";
import {
  createFleetMailbox,
  createListAgentsTool,
  createWaitAgentsTool,
} from "../../subagent/agent-fleet.js";
import { createFleetWakePublisher } from "./wiring.js";
import {
  attachSessionBridge,
  type BridgeInboundEvent,
} from "../runtime-bridge.js";
import { createLiveSessionPort } from "../live-session-port.js";
import { createAppShell } from "../shell/index.js";
import { withTestRenderer, type Harness } from "../harness.js";
import { resetSessionForRotation } from "./exit.js";
import { clearTranscript, setMcpNeedsAuth } from "../shell/chrome.js";
import type { AppShell } from "../shell/internals.js";
import { closeInsetOverlay } from "../shell/overlay-host.js";
import { submitPrompt } from "../shell/prompt.js";
import { wireGates } from "../gate-wire.js";
import { ASK_DIRECTOR_WAKE_PREFIX } from "../../subagent/fleet-report.js";
import {
  createDeliveryGeneration,
  createLeftoverSend,
  createSessionOperationQueue,
} from "../delivery-queue.js";

test("failed reset releases publication without flushing partially cancelled workers", () => {
  const store = createSubAgentSessionStore();
  const emitter = new EventEmitter();
  const publisher = createFleetWakePublisher(store, emitter);
  const events: BridgeInboundEvent[] = [];
  emitter.on("event", (event: BridgeInboundEvent) => events.push(event));
  const unsubscribe = store.subscribe(publisher.publish);
  try {
    store.start({
      id: "old",
      agentId: "builder",
      description: "old",
      brief: "build",
    });
    store.markRunning("old");
    store.registerAsk("old", {
      question: "Old question?",
      questionId: "old-question",
      resolve: () => undefined,
      reject: () => undefined,
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

test("fleet-wake publisher reports fleet-count transitions to the idle-with-fleet follower", () => {
  const store = createSubAgentSessionStore();
  const emitter = new EventEmitter();
  const seen: number[] = [];
  const publisher = createFleetWakePublisher(store, emitter, (running) => {
    seen.push(running);
  });
  // Steady empty state: no transition, no callback.
  publisher.publish();
  expect(seen).toEqual([]);
  store.start({
    id: "worker-one",
    agentId: "builder",
    description: "worker-one",
    brief: "build",
  });
  // A started lane counts as running: 0 -> 1 transition.
  publisher.publish();
  expect(seen).toEqual([1]);
  store.markRunning("worker-one");
  publisher.publish();
  expect(seen).toEqual([1]);
  // Steady fleet: no repeat callback.
  publisher.publish();
  expect(seen).toEqual([1]);
  store.cancelAll("Session cleared");
  publisher.publish();
  expect(seen).toEqual([1, 0]);
});

test("interrupt-all with no running workers publishes live count 0", () => {
  const store = createSubAgentSessionStore();
  const emitter = new EventEmitter();
  const seen: number[] = [];
  const publisher = createFleetWakePublisher(store, emitter, (running) => {
    seen.push(running);
  });
  store.start({
    id: "worker-one",
    agentId: "builder",
    description: "worker-one",
    brief: "build",
  });
  store.markRunning("worker-one");
  store.registerInterrupt("worker-one", () => undefined);
  store.start({
    id: "worker-two",
    agentId: "builder",
    description: "worker-two",
    brief: "build",
  });
  store.markRunning("worker-two");
  store.registerInterrupt("worker-two", () => undefined);
  publisher.publish();
  expect(seen).toEqual([2]);
  expect(store.interruptOne("worker-one").ok).toBe(true);
  expect(store.interruptOne("worker-two").ok).toBe(true);
  publisher.publish();
  expect(seen).toEqual([2, 0]);
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
            interrupt: () => undefined,
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
          store.start({
            id,
            agentId: "builder",
            description: id,
            brief: "build",
          });
          store.markRunning(id);
          store.registerAsk(id, {
            question: `question ${id}`,
            questionId: `question-${id}`,
            resolve: () => undefined,
            reject: () => undefined,
          });
        };
        try {
          for (let round = 0; round < 2; round++) {
            bridge.handle({ type: "inference.start", data: {} });
            start(`old-${round}-one`);
            start(`old-${round}-two`);
            if (phase !== "deferred")
              bridge.handle({ type: "inference.done", data: {} });
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
            expect(shell.workerWait.items).toEqual([]);
            expect(shell.workerWaitRow.visible).toBe(false);
            expect(
              store.list().every((worker) => worker.status === "cancelled"),
            ).toBe(true);
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

for (const removal of [
  "answer",
  "cancel",
  "terminal",
  "remove",
  "replace",
] as const) {
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
          createLiveSessionPort({
            send,
            deliver: send,
            interrupt: () => undefined,
          }),
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
            resolve: () => undefined,
            reject: () => undefined,
          });
          expect(shell.workerWait.items.map((item) => item.sessionId)).toEqual([
            worker.id,
          ]);
          expect(shell.workerWaitRow.visible).toBe(true);
          if (removal === "answer") {
            const mailbox = createFleetMailbox(store);
            mailbox.register(worker.id);
            const wait = createWaitAgentsTool({
              sessions: store,
              fleetRecords: mailbox,
            });
            if (wait.kind !== "full")
              throw new Error("expected full wait tool");
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
          expect(
            events.at(-1)?.type === "fleet" ? events.at(-2) : events.at(-1),
          ).toEqual({
            type: "agent-ask",
            asks: [],
          });
          expect(shell.workerWait.items).toEqual([]);
          expect(shell.workerWaitRow.visible).toBe(false);
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
        createLiveSessionPort({
          send,
          deliver: send,
          interrupt: () => undefined,
        }),
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
          reject: () => undefined,
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

test("yield wait does not stamp; sending pendingAskWakeText gates list_agents", async () => {
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
      const store = createSubAgentSessionStore();
      const mailbox = createFleetMailbox(store);
      const bridge = attachSessionBridge(
        shell,
        createLiveSessionPort({
          send,
          deliver: send,
          interrupt: () => undefined,
        }),
      );
      bridge.setOnAskWakeSent((asks) => {
        mailbox.noteParkedAsksSurfaced(
          asks.map((ask) => ({
            id: ask.sessionId,
            questionId: ask.questionId,
          })),
        );
      });
      const emitter = new EventEmitter();
      emitter.on("event", (event: BridgeInboundEvent) => bridge.handle(event));
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
        mailbox.register(worker.id);
        store.markRunning(worker.id);
        store.registerAsk(worker.id, {
          question: "Which port?",
          questionId: "q1",
          resolve: () => undefined,
          reject: () => undefined,
        });
        const wait = createWaitAgentsTool({
          sessions: store,
          fleetRecords: mailbox,
          shouldYieldWait: () =>
            mailbox.peek(worker.id)?.status === "awaiting_director",
        });
        if (wait.kind !== "full") throw new Error("expected full wait tool");
        const waited = await wait.handler(
          {
            id: "wait-call",
            name: "wait_agents",
            arguments: { targets: [worker.id], timeout_ms: 1000 },
          },
          new AbortController().signal,
        );
        const waitContent =
          typeof waited.content === "string"
            ? waited.content
            : JSON.stringify(waited.content);
        expect(waitContent).toContain("awaiting_director");
        expect(waitContent).not.toContain("Which port?");
        expect(sends).toEqual([]);
        const list = createListAgentsTool({
          sessions: store,
          fleetRecords: mailbox,
        });
        if (list.kind !== "full") throw new Error("expected full list tool");
        bridge.handle({ type: "inference.done", data: {} });
        expect(sends).toHaveLength(1);
        expect(sends[0]).toContain("Which port?");
        const afterWake = await list.handler(
          { id: "list-after", name: "list_agents", arguments: {} },
          new AbortController().signal,
        );
        const afterContent =
          typeof afterWake.content === "string"
            ? afterWake.content
            : JSON.stringify(afterWake.content);
        expect(afterWake.isError).toBe(true);
        expect(afterContent.startsWith("Error:")).toBe(true);
        expect(afterContent).toContain("send_input");
        expect(afterContent).toContain(worker.id);
        expect(afterContent).toContain("q1");
        expect(afterContent).toContain("Which port?");
      } finally {
        unsubscribe();
        bridge.dispose();
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
});

interface StripRig {
  readonly shell: AppShell;
  readonly h: Harness;
  readonly bridge: ReturnType<typeof attachSessionBridge>;
  readonly store: ReturnType<typeof createSubAgentSessionStore>;
  readonly emitter: EventEmitter;
  /** Everything the primary session port was handed, in order. */
  readonly toPrimary: string[];
  readonly answers: string[];
  readonly park: (id: string, questionId: string, question: string) => void;
}

async function withStripRig(fn: (rig: StripRig) => Promise<void>) {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 120, rows: 30 },
        wireKeys: false,
      });
      const toPrimary: string[] = [];
      const answers: string[] = [];
      const bridge = attachSessionBridge(
        shell,
        createLiveSessionPort({
          send: (text) => {
            toPrimary.push(text);
          },
          deliver: (text) => {
            toPrimary.push(text);
          },
          interrupt: () => undefined,
        }),
      );
      const store = createSubAgentSessionStore();
      const emitter = new EventEmitter();
      emitter.on("event", (event: BridgeInboundEvent) => bridge.handle(event));
      const publisher = createFleetWakePublisher(store, emitter);
      const unsubscribe = store.subscribe(publisher.publish);
      const disposeGates = wireGates(emitter, shell, {
        onGateOpened: () => bridge.gateOpened(),
        onGateClosed: () => bridge.gateClosed(),
      });
      const park = (id: string, questionId: string, question: string) => {
        if (store.list().every((lane) => lane.id !== id)) {
          store.start({ id, agentId: "builder", description: id, brief: "b" });
          store.markRunning(id);
        }
        store.registerAsk(id, {
          question,
          questionId,
          resolve: (answer) => {
            answers.push(`${id}:${answer}`);
          },
          reject: () => undefined,
        });
      };
      try {
        await fn({
          shell,
          h,
          bridge,
          store,
          emitter,
          toPrimary,
          answers,
          park,
        });
      } finally {
        disposeGates();
        unsubscribe();
        bridge.dispose();
        shell.dispose();
      }
    },
    { width: 120, height: 30 },
  );
}

async function stripText(h: Harness): Promise<string | undefined> {
  await h.renderOnce();
  await h.renderOnce();
  return h
    .captureCharFrame()
    .split("\n")
    .find((row) => row.includes("WAITING"));
}

test("the strip follows agent-ask snapshots while the wake reaches the director and send_input resolves it", async () => {
  await withStripRig(
    async ({ shell, h, bridge, store, toPrimary, answers, park }) => {
      bridge.handle({ type: "inference.start", data: {} });
      park("worker-session", "q1", "Which destination path should I use?");
      const parked = await stripText(h);
      expect(parked).toContain("WORKER WAITING");
      expect(parked).toContain("Which destination path should I use?");
      expect(toPrimary).toEqual([]);

      // The primary settles: the wake goes to the director, the strip stays.
      bridge.handle({ type: "inference.done", data: {} });
      expect(toPrimary).toHaveLength(1);
      expect(toPrimary[0]).toContain("Which destination path should I use?");
      expect(toPrimary[0]).toContain("using target worker-session");
      expect(await stripText(h)).toBe(parked);

      // Director inference on the wake and its settlement are not resolution.
      bridge.handle({ type: "inference.start", data: {} });
      expect(await stripText(h)).toBe(parked);
      bridge.handle({ type: "inference.done", data: {} });
      expect(await stripText(h)).toBe(parked);

      // A republished snapshot of the same identity does not duplicate it.
      store.wake();
      expect(shell.workerWait.items).toHaveLength(1);
      expect(toPrimary).toHaveLength(1);

      // Only the director's send_input to the worker session resolves it.
      expect(store.sendInputOne("worker-session", "/srv/out").ok).toBe(true);
      expect(answers).toEqual(["worker-session:/srv/out"]);
      expect(await stripText(h)).toBeUndefined();
      expect(shell.workerWaitRow.visible).toBe(false);
    },
  );
});

test("multiple parked workers keep the displayed identity and an accurate count", async () => {
  await withStripRig(async ({ shell, h, bridge, store, park }) => {
    bridge.handle({ type: "inference.start", data: {} });
    park("first", "q1", "First question?");
    park("second", "q2", "Second question?");
    park("third", "q3", "Third question?");
    let strip = await stripText(h);
    expect(strip).toContain("First question?");
    expect(strip).toContain("(+2 more)");

    // A later worker's replacement question leaves the displayed one alone.
    store.cancelAsk("third");
    park("third", "q4", "Third replacement?");
    strip = await stripText(h);
    expect(strip).toContain("First question?");
    expect(strip).toContain("(+2 more)");
    expect(shell.workerWait.items.map((item) => item.questionId)).toEqual([
      "q1",
      "q2",
      "q4",
    ]);

    // The displayed identity resolves: fall back to snapshot order.
    expect(store.sendInputOne("first", "ok").ok).toBe(true);
    strip = await stripText(h);
    expect(strip).toContain("Second question?");
    expect(strip).toContain("(+1 more)");
  });
});

test("composer submission still goes to the director and never answers or clears the worker", async () => {
  await withStripRig(
    async ({ shell, h, bridge, store, toPrimary, answers, park }) => {
      bridge.handle({ type: "inference.start", data: {} });
      park("worker-session", "q1", "Which destination path should I use?");
      bridge.handle({ type: "inference.done", data: {} });
      expect(toPrimary).toHaveLength(1);
      const parked = await stripText(h);

      // Mid wake turn: Enter queues a steer for the primary session.
      bridge.handle({ type: "inference.start", data: {} });
      shell.prompt.value = "try /srv/out";
      submitPrompt(shell, "steer");
      expect(shell.session.items.map((item) => item.text)).toEqual([
        "try /srv/out",
      ]);
      expect(answers).toEqual([]);
      expect(store.hasPendingAsk("worker-session")).toBe(true);
      expect(await stripText(h)).toBe(parked);
      bridge.handle({ type: "inference.done", data: {} });

      // Idle with the worker still live: Enter is a new primary turn and the
      // operator's words reach the director verbatim.
      shell.prompt.value = "/srv/out";
      submitPrompt(shell, "steer");
      expect(toPrimary.at(-1)).toBe("/srv/out");
      expect(answers).toEqual([]);
      expect(store.hasPendingAsk("worker-session")).toBe(true);
      expect(await stripText(h)).toBe(parked);

      // Typing alone changes nothing either.
      shell.prompt.value = "still thinking";
      expect(await stripText(h)).toBe(parked);
      expect(store.hasPendingAsk("worker-session")).toBe(true);
    },
  );
});

test("ask_operator and permission gates never activate the strip", async () => {
  await withStripRig(async ({ shell, h, bridge, emitter }) => {
    bridge.handle({ type: "inference.start", data: {} });
    let operatorAnswer: unknown;
    emitter.emit("operator.gate", {
      id: "ask-1",
      question: "Which destination path should I use?",
      options: ["Cancel", "Continue"],
      resolve: (value: unknown) => {
        operatorAnswer = value;
      },
    });
    expect(shell.overlayList).not.toBeNull();
    expect(shell.workerWait.items).toEqual([]);
    expect(shell.layout.heights.worker_wait).toBe(0);
    expect(await stripText(h)).toBeUndefined();
    closeInsetOverlay(shell);
    expect(operatorAnswer).toBeDefined();

    emitter.emit("permission.gate", {
      id: "req-1",
      request: {
        tool: "run_shell",
        action: "Run shell command",
        subject: "rm -rf build",
        scopes: [],
      },
      resolve: () => undefined,
    });
    expect(shell.overlayKind).toBe("permissions");
    expect(shell.workerWait.items).toEqual([]);
    expect(await stripText(h)).toBeUndefined();
  });
});

test("transcript wake text, status events and MCP attention never activate the strip", async () => {
  await withStripRig(async ({ shell, h, bridge }) => {
    bridge.handle({
      type: "assistant",
      text: `${ASK_DIRECTOR_WAKE_PREFIX} worker builder parked question q1`,
    });
    bridge.handle({ type: "system", text: "worker builder is waiting" });
    bridge.handle({ type: "fleet", running: 2 });
    setMcpNeedsAuth(shell, ["granola"]);
    expect(shell.workerWait.items).toEqual([]);
    expect(shell.layout.heights.worker_wait).toBe(0);
    expect(await stripText(h)).toBeUndefined();
  });
});

test("a live strip and an ask_operator overlay stay separate", async () => {
  await withStripRig(async ({ shell, h, bridge, emitter, store, park }) => {
    bridge.handle({ type: "inference.start", data: {} });
    park("worker-session", "q1", "Which destination path should I use?");
    const parked = await stripText(h);
    emitter.emit("operator.gate", {
      id: "ask-2",
      question: "Ship it?",
      options: ["No", "Yes"],
      resolve: () => undefined,
    });
    expect(shell.overlayList).not.toBeNull();
    expect(await stripText(h)).toBe(parked);
    closeInsetOverlay(shell);
    expect(await stripText(h)).toBe(parked);
    expect(store.hasPendingAsk("worker-session")).toBe(true);
  });
});

test("bridge teardown clears the strip", async () => {
  await withStripRig(async ({ shell, h, bridge, park }) => {
    bridge.handle({ type: "inference.start", data: {} });
    park("worker-session", "q1", "Which destination path should I use?");
    expect(await stripText(h)).toContain("WORKER WAITING");
    bridge.dispose();
    expect(shell.workerWait.items).toEqual([]);
    expect(await stripText(h)).toBeUndefined();
  });
});
