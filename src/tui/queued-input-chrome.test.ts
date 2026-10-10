import { expect, test } from "bun:test";
import { createReactor, type ReactorEmittedEvent } from "@intx/inference";
import { createDefaultDependencies } from "@intx/inference/providers";
import type {
  ContextCommit,
  ContextStore,
  InboundMessage,
  ReactorCapabilities,
  ReactorDirector,
  ReactorState,
  TokenUsage,
} from "@intx/types/runtime";
import { withTestRenderer } from "./harness.js";
import { attachSessionBridge, type SessionBridge } from "./runtime-bridge.js";
import { paintChrome, relayout, setWorkerWaitAsks } from "./shell/chrome.js";
import { createAppShell } from "./shell/index.js";
import type { PendingAskWake } from "../subagent/fleet-report.js";
import { createLiveSessionPort } from "./live-session-port.js";
import {
  createLiveSteerDeliver,
  createSessionOperationQueue,
  deliverAgentMessage,
  routeQueuedDelivery,
} from "./delivery-queue.js";
import { userInboundMessage } from "./runner/submit.js";

const WAITING: PendingAskWake = {
  sessionId: "worker-session",
  agentId: "worker",
  description: "inspect state",
  question: "Should I continue?",
  questionId: "question",
};

function received(
  messageId: string,
  flags: readonly string[] = ["operator-originated"],
) {
  return {
    type: "message.received",
    data: { message: { content: "same text", flags, headers: { messageId } } },
  };
}

function started(messageId: string) {
  return { type: "message.run.started", data: { messageId } };
}

test("accepted input chrome consumes only matching operator identities and survives redraw", async () => {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      });
      const bridge = attachSessionBridge(shell);
      try {
        bridge.recordAcceptedInput("first");
        bridge.recordAcceptedInput("second");
        bridge.recordAcceptedInput("first");
        expect(shell.queuedInput.messageIds).toEqual(["first", "second"]);

        bridge.handle(received("foreign", ["system"]));
        bridge.handle({
          type: "message.received",
          data: { message: { content: "same text" } },
        });
        expect(shell.queuedInput.messageIds).toEqual(["first", "second"]);

        // Receipt alone never consumes the ledger: the read signal is
        // message.run.started.
        bridge.handle(received("second"));
        expect(shell.queuedInput.messageIds).toEqual(["first", "second"]);
        shell.prompt.value = "keep this draft";
        paintChrome(shell, { force: true });
        expect(shell.prompt.value).toBe("keep this draft");
        expect(shell.queuedInputRow.visible).toBe(true);

        bridge.handle(started("second"));
        expect(shell.queuedInput.messageIds).toEqual(["first"]);
        bridge.handle(started("first"));
        expect(shell.queuedInput.messageIds).toEqual([]);
        expect(shell.queuedInputRow.visible).toBe(false);
      } finally {
        bridge.dispose();
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
});

test("steer path: accept between receive and read keeps depth 1 until message.run.started", async () => {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      });
      const bridge = attachSessionBridge(shell);
      try {
        bridge.beginQueuedInputDelivery("racing");
        bridge.handle(received("racing"));
        expect(shell.queuedInput.messageIds).toEqual([]);
        bridge.recordAcceptedInput("racing");
        // The director has not read the steer: the row must be visible.
        expect(shell.queuedInput.messageIds).toEqual(["racing"]);
        expect(shell.queuedInputRow.visible).toBe(true);

        bridge.handle(started("racing"));
        expect(shell.queuedInput.messageIds).toEqual([]);
        expect(shell.queuedInputRow.visible).toBe(false);

        bridge.recordAcceptedInput("cleared");
        bridge.clearQueuedDelivery();
        expect(shell.queuedInput.messageIds).toEqual([]);
        bridge.dispose();
        bridge.recordAcceptedInput("late");
        expect(shell.queuedInput.messageIds).toEqual([]);
      } finally {
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
});

test("send path: read before accept produces no ledger entry", async () => {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      });
      const bridge = attachSessionBridge(shell);
      try {
        bridge.beginQueuedInputDelivery("sending");
        bridge.handle(received("sending"));
        bridge.handle(started("sending"));
        // The send resolves accepted only after the director already read the
        // message: never paint a stale row.
        bridge.recordAcceptedInput("sending");
        expect(shell.queuedInput.messageIds).toEqual([]);
        expect(shell.queuedInputRow.visible).toBe(false);
      } finally {
        bridge.dispose();
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
});

test("a delayed acceptance remains correlated after high-volume receives", async () => {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      });
      const bridge = attachSessionBridge(shell);
      try {
        bridge.beginQueuedInputDelivery("racing");
        bridge.handle(received("racing"));
        for (let index = 0; index <= 1000; index += 1) {
          bridge.handle(received(`other-${index}`));
        }
        bridge.recordAcceptedInput("racing");

        expect(shell.queuedInput.messageIds).toEqual(["racing"]);
        expect(shell.queuedInputRow.visible).toBe(true);

        bridge.handle(started("racing"));
        expect(shell.queuedInput.messageIds).toEqual([]);
        expect(shell.queuedInputRow.visible).toBe(false);
      } finally {
        bridge.dispose();
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
});

test("duplicate receives and duplicate read signals are idempotent", async () => {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      });
      const bridge = attachSessionBridge(shell);
      try {
        bridge.recordAcceptedInput("one");
        bridge.recordAcceptedInput("one");
        expect(shell.queuedInput.messageIds).toEqual(["one"]);
        bridge.handle(received("one"));
        bridge.handle(received("one"));
        expect(shell.queuedInput.messageIds).toEqual(["one"]);
        bridge.handle(started("one"));
        bridge.handle(started("one"));
        expect(shell.queuedInput.messageIds).toEqual([]);
        expect(shell.queuedInputRow.visible).toBe(false);
      } finally {
        bridge.dispose();
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
});

test("malformed receive and read payloads never disturb the ledger", async () => {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      });
      const bridge = attachSessionBridge(shell);
      try {
        bridge.recordAcceptedInput("kept");
        bridge.handle({ type: "message.received", data: null });
        bridge.handle({ type: "message.received", data: {} });
        bridge.handle({
          type: "message.received",
          data: { message: { content: "no headers" } },
        });
        bridge.handle({ type: "message.run.started", data: null });
        bridge.handle({ type: "message.run.started", data: {} });
        bridge.handle({
          type: "message.run.started",
          data: { messageId: 42 },
        });
        expect(shell.queuedInput.messageIds).toEqual(["kept"]);
        bridge.handle(started("kept"));
        expect(shell.queuedInput.messageIds).toEqual([]);
      } finally {
        bridge.dispose();
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
});

test("queued input and worker waiting occupy independent bottom-stack rows", async () => {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 32, rows: 24 },
        wireKeys: false,
      });
      const bridge = attachSessionBridge(shell);
      try {
        bridge.recordAcceptedInput("one");
        setWorkerWaitAsks(shell, [WAITING]);
        await h.renderOnce();
        await h.renderOnce();
        const rows = h.captureCharFrame().split("\n");
        const waiting = rows.findIndex((row) => row.includes("WAITING"));
        const queued = rows.findIndex((row) => row.includes("QUEUED"));
        expect(waiting).toBeGreaterThanOrEqual(0);
        expect(queued).toBeGreaterThan(waiting);
        expect(shell.layout.heights.worker_wait).toBe(1);
        expect(shell.layout.heights.queued_input).toBe(1);
        expect(shell.layout.regions.worker_wait?.y).toBeLessThan(
          shell.layout.regions.queued_input?.y ?? -1,
        );

        relayout(shell, { columns: 12, rows: 10 });
        expect(shell.layout.regions.prompt?.y ?? 0).toBeLessThan(10);
        expect(shell.queuedInput.messageIds).toEqual(["one"]);
      } finally {
        bridge.dispose();
        shell.dispose();
      }
    },
    { width: 32, height: 24 },
  );
});

test("busy-Enter pending-only produces no ledger entry until acceptance", async () => {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "busy",
      });
      const bridge = attachSessionBridge(shell);
      try {
        bridge.submit("held follow-up", "steer");
        // The item sits in the pending column: Enter alone never records an
        // accepted input.
        expect(shell.session.items).toHaveLength(1);
        expect(shell.queuedInput.messageIds).toEqual([]);
        expect(shell.queuedInputRow.visible).toBe(false);
      } finally {
        bridge.dispose();
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
});

test("late accept after /clear or /new is inert (generation check)", async () => {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      });
      const bridge = attachSessionBridge(shell);
      try {
        // A live steer begins before the session rotates (/clear or /new both
        // route through clearQueuedDelivery).
        bridge.beginQueuedInputDelivery("old-session-steer");
        bridge.clearQueuedDelivery();
        // The stale accept lands after the clear: the row must not paint.
        bridge.recordAcceptedInput("old-session-steer");
        expect(shell.queuedInput.messageIds).toEqual([]);
        expect(shell.queuedInputRow.visible).toBe(false);

        // A fresh session's delivery still works normally.
        bridge.beginQueuedInputDelivery("new-session-steer");
        bridge.recordAcceptedInput("new-session-steer");
        expect(shell.queuedInput.messageIds).toEqual(["new-session-steer"]);
        bridge.handle(started("new-session-steer"));
        expect(shell.queuedInput.messageIds).toEqual([]);
      } finally {
        bridge.dispose();
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
});

test("delivered ask wake never enters the queued-input ledger", async () => {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      });
      const delivered: {
        text: string;
        kind: string;
        operatorOriginated: boolean | undefined;
      }[] = [];
      const bridge = attachSessionBridge(
        shell,
        createLiveSessionPort({
          send: () => undefined,
          interrupt: () => undefined,
          deliver: (text, kind, _attachments, _settle, operatorOriginated) => {
            delivered.push({ text, kind, operatorOriginated });
          },
        }),
      );
      try {
        bridge.handle({ type: "agent-ask", asks: [WAITING] });
        // The wake leaves through the port marked as harness text, so it can
        // never read as operator input or paint a queued-input row.
        expect(delivered).toHaveLength(1);
        expect(delivered[0]?.operatorOriginated).toBe(false);
        expect(delivered[0]?.text.startsWith("ask_director wake")).toBe(true);
        expect(shell.queuedInput.messageIds).toEqual([]);
        expect(shell.queuedInputRow.visible).toBe(false);
      } finally {
        bridge.dispose();
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
});

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
}

function makeContextStore(): ContextStore {
  async function commit(
    options: { message: string },
    _signal?: AbortSignal,
  ): Promise<ContextCommit> {
    return { hash: "abc", message: options.message, timestamp: Date.now() };
  }
  return {
    async load() {
      return {
        turns: [],
        pendingOperations: [],
        tokenUsage: emptyUsage(),
        connectorState: null,
      };
    },
    setConnectorState() {
      /* noop */
    },
    commit,
    async branch() {
      /* noop */
    },
    async log() {
      return [];
    },
    async readAt() {
      return [];
    },
    async writeBlob() {
      /* noop */
    },
    async readBlob(key) {
      throw new Error(`no blob for key ${key}`);
    },
    async writePrompt() {
      /* noop */
    },
    async writeResponse() {
      /* noop */
    },
    async writeManifest() {
      /* noop */
    },
    async writeTurns() {
      /* noop */
    },
    async writeMetadata() {
      /* noop */
    },
    async readManifestHistory() {
      return [];
    },
  };
}

function inboundMessage(content: string): InboundMessage {
  return {
    ref: { uid: 1, mailbox: "INBOX" },
    headers: {
      from: "user@local",
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: `<${crypto.randomUUID()}@local>`,
      interchangeType: "conversation.message",
    },
    flags: [],
    signatureStatus: "missing",
    content,
  };
}

async function tickUntil(
  predicate: () => boolean,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      throw new Error("tickUntil timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("mid-run steer paints QUEUED INPUT until the real director reads it", async () => {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "busy",
      });
      let releaseTool: () => void = () => undefined;
      const toolGate = new Promise<void>((resolve) => {
        releaseTool = resolve;
      });
      // The steer becomes visible only while the director has not read it: the
      // second inference holds the cycle open, so the steer's message.received
      // waits behind it and message.run.started has not fired. Releasing this
      // gate lets the cycle settle and the director read the steer.
      let releaseSecondInfer: () => void = () => undefined;
      const secondInferGate = new Promise<void>((resolve) => {
        releaseSecondInfer = resolve;
      });
      let receivedCount = 0;
      let inferCount = 0;
      const events: ReactorEmittedEvent[] = [];
      const steerMessageId: { current: string | undefined } = {
        current: undefined,
      };
      const bridgeRef: { current: SessionBridge | undefined } = {
        current: undefined,
      };
      const queue = createSessionOperationQueue();

      const director: ReactorDirector = {
        async decide(event, _state: ReactorState, caps: ReactorCapabilities) {
          if (event.type === "message.received") {
            receivedCount += 1;
            if (receivedCount === 1) return [caps.infer()];
            return [caps.reply("steer read")];
          }
          if (event.type === "inference.done") {
            const toolCall = event.turn.content.find(
              (block) => block.type === "tool_call",
            );
            if (toolCall !== undefined) {
              return [
                caps.executeTools([
                  {
                    id: toolCall.id,
                    name: toolCall.name,
                    arguments: toolCall.arguments,
                  },
                ]),
              ];
            }
            return [caps.reply("ok")];
          }
          if (event.type === "tool.done") return [caps.infer()];
          return [caps.done()];
        },
      };

      const reactor = createReactor({
        sessionId: "cl-10437-steer-probe",
        director,
        source: {
          id: "probe:model",
          provider: "openai",
          baseURL: "https://probe.invalid",
          credentialId: "probe",
          model: "probe-model",
        },
        toolRunner: {
          async run(call) {
            await toolGate;
            return { callId: call.id, content: "tool result" };
          },
        },
        contextStore: makeContextStore(),
        onEvent: (event) => {
          events.push(event);
          bridgeRef.current?.handle(event);
        },
        deps: createDefaultDependencies(),
        doomLoopThreshold: false,
        inferenceRunner(opts) {
          return (async function* () {
            inferCount += 1;
            if (inferCount === 2) await secondInferGate;
            yield {
              type: "inference.start",
              seq: opts.nextSeq(),
              data: { model: "probe-model" },
            };
            if (inferCount === 1) {
              // First inference: the model asks for a tool, which keeps the
              // parent cycle live while the operator steers mid-run.
              yield {
                type: "inference.tool_call.start",
                seq: opts.nextSeq(),
                data: {
                  callId: "call-1",
                  name: "probe_tool",
                  partial: { text: "" },
                },
              };
              yield {
                type: "inference.tool_call.end",
                seq: opts.nextSeq(),
                data: {
                  callId: "call-1",
                  name: "probe_tool",
                  arguments: {},
                  partial: { text: "" },
                },
              };
            }
            yield {
              type: "inference.done",
              seq: opts.nextSeq(),
              data: {
                turn:
                  inferCount === 1
                    ? {
                        role: "assistant",
                        content: [
                          {
                            type: "tool_call",
                            id: "call-1",
                            name: "probe_tool",
                            arguments: {},
                          },
                        ],
                        model: "probe-model",
                        timestamp: Date.now(),
                      }
                    : {
                        role: "assistant",
                        content: [{ type: "text", text: "ok" }],
                        model: "probe-model",
                        timestamp: Date.now(),
                      },
                usage: emptyUsage(),
                source: {
                  sourceId: "probe:model",
                  provider: "openai",
                  model: "probe-model",
                },
              },
            };
          })();
        },
      });

      const agent = {
        deliver: (message: InboundMessage) => {
          reactor.deliver(message);
        },
      };

      const bridge = attachSessionBridge(
        shell,
        createLiveSessionPort({
          send: (text) => {
            throw new Error(
              `probe should not use the leftover send path: ${text}`,
            );
          },
          interrupt: () => undefined,
          deliver: routeQueuedDelivery({
            send: (text) => {
              throw new Error(
                `probe should not use the leftover send path: ${text}`,
              );
            },
            deliverSteer: createLiveSteerDeliver({
              enqueue: queue.enqueue,
              ingest: async (text, pending) => ({
                text,
                attachments: pending,
              }),
              deliver: (text, pending, settle) => {
                const message = userInboundMessage(text, pending);
                const messageId = message.headers.messageId;
                steerMessageId.current = messageId;
                bridge.beginQueuedInputDelivery(messageId);
                void deliverAgentMessage({
                  getFatalBuildError: () => null,
                  deliverToLiveAgent: () => agent.deliver(message),
                }).then((result) => {
                  if (result.status === "accepted") {
                    bridge.recordAcceptedInput(messageId);
                  } else {
                    bridge.discardQueuedInputDelivery(messageId);
                  }
                  settle?.(result);
                });
              },
              captureGeneration: () => () => true,
              onFailure: (err) => {
                throw err;
              },
            }),
            parentCycleLive: () => bridgeRef.current?.parentCycleLive === true,
          }),
        }),
      );
      bridgeRef.current = bridge;
      try {
        reactor.start();
        reactor.deliver(inboundMessage("start the task"));
        await tickUntil(() => events.some((e) => e.type === "tool.start"));

        bridge.submit("steer the ship", "steer");
        expect(shell.queuedInput.messageIds).toEqual([]);
        expect(shell.queuedInputRow.visible).toBe(false);

        // Release the tool: the boundary drains the steer, the live deliver
        // accepts it, and the row paints because the director has not read the
        // steer (the second inference is gated, so the steer's message.received
        // still waits behind the cycle).
        releaseTool();
        await tickUntil(() => shell.queuedInput.messageIds.length === 1, 4000);
        const steerId = steerMessageId.current;
        expect(steerId).toBeDefined();
        const steerIdValue: string = steerId as string;
        expect(shell.queuedInput.messageIds).toEqual([steerIdValue]);
        expect(shell.queuedInputRow.visible).toBe(true);
        expect(
          events.some(
            (e) =>
              e.type === "message.run.started" &&
              (e.data as { messageId?: string }).messageId === steerIdValue,
          ),
        ).toBe(false);

        // Release the second inference: the cycle settles, the reactor dequeues
        // the steer, message.run.started fires, and the row disappears.
        releaseSecondInfer();
        await tickUntil(
          () =>
            events.some(
              (e) =>
                e.type === "message.run.started" &&
                (e.data as { messageId?: string }).messageId === steerIdValue,
            ),
          4000,
        );
        await tickUntil(() => shell.queuedInput.messageIds.length === 0, 4000);
        expect(shell.queuedInputRow.visible).toBe(false);
      } finally {
        reactor.abort("admin_kill");
        bridge.dispose();
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
});
