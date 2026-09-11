import { describe, expect, test } from "bun:test";
import { AgentClosedError, type Agent } from "@intx/agent";
import type { InboundMessage } from "@intx/types/runtime";
import { defined } from "../../../tests/helpers/defined.js";
import {
  CLOSED_AGENT_NOTICE,
  CLOSED_AGENT_PROMPT_NOTICE,
  CLOSED_AGENT_QUEUE_NOTICE,
} from "../deliver-agent-message.js";
import { withTestRenderer } from "../harness.js";
import { createLiveSessionPort } from "../live-session-port.js";
import { createDeliveryGeneration } from "../queued-delivery.js";
import { attachSessionBridge } from "../runtime-bridge.js";
import {
  createSessionOperationQueue,
  type SessionOperationQueue,
} from "../session-operation-queue.js";
import type { QueueItem } from "../session-queue.js";
import { createAppShell } from "../shell/index.js";
import { createDeliverRouting } from "./submit.js";
import type { RunnerHost, RunnerServices, RunnerState } from "./state.js";

const original: QueueItem = {
  id: "q7",
  text: "follow up",
  kind: "queue",
  enqueuedAt: 1,
};

function closedAgent(args: {
  send?: (message: InboundMessage) => Promise<unknown>;
  deliver?: (message: InboundMessage) => void;
}): Agent {
  return {
    send: args.send ?? (() => Promise.reject(new AgentClosedError())),
    deliver:
      args.deliver ??
      (() => {
        throw new AgentClosedError();
      }),
  } as unknown as Agent;
}

function routingHarness(args?: {
  parentCycleLive?: boolean;
  fatalBuildError?: Error | null;
  destination?: "queue" | "prompt";
  agent?: Agent;
  agentProxy?: Agent;
  sessionOps?: SessionOperationQueue;
}) {
  const recovered: QueueItem[] = [];
  const notices: string[] = [];
  const sendFailures: unknown[] = [];
  const sessionOps = args?.sessionOps ?? createSessionOperationQueue();
  const agent = args?.agent ?? closedAgent({});
  const state = {
    fatalBuildError: args?.fatalBuildError ?? null,
    sendAborted: false,
    config: { cwd: "/tmp" },
    sessionId: "s",
    inFlight: 0,
    currentAgent: agent,
    systemNotice: (text: string) => {
      notices.push(text);
    },
    handleSendFailure: (error: unknown) => {
      sendFailures.push(error);
    },
    sendWithAttemptIdentity: async (message: InboundMessage) => {
      await agent.send(message);
      return true;
    },
    host: {
      bridge: {
        parentCycleLive: args?.parentCycleLive === true,
        recoverUndelivered: (item: QueueItem) => {
          recovered.push(item);
          return args?.destination ?? "prompt";
        },
      },
    },
  } as unknown as RunnerState;
  const services = {
    sessionOps,
    deliveryGeneration: createDeliveryGeneration(),
    approvalResume: {
      handle: async () => undefined,
    },
  } as unknown as RunnerServices;
  const deliver = createDeliverRouting(state, services, {
    attemptIdentity: () => ({ providerId: "p" }),
    agentProxy: args?.agentProxy ?? agent,
  });
  return {
    deliver,
    recovered,
    notices,
    sendFailures,
    sessionOps,
    agent,
    state,
  };
}

describe("createDeliverRouting closed-agent restore", () => {
  test("leftover Agent.send rejection restores the original item and destination notice", async () => {
    const { deliver, recovered, notices, sendFailures, sessionOps } =
      routingHarness({ destination: "prompt" });

    deliver(original.text, original.kind, original.attachments, original);
    await sessionOps.awaitTail();

    expect(recovered).toEqual([original]);
    expect(notices).toEqual([CLOSED_AGENT_PROMPT_NOTICE]);
    expect(sendFailures).toEqual([]);
    expect(notices.join("\n").toLowerCase()).not.toContain("agent is closed");
  });

  test("fatal rebuild never hops and restores the original item", async () => {
    let hopped = false;
    const { deliver, recovered, notices, sendFailures, sessionOps } =
      routingHarness({
        destination: "queue",
        fatalBuildError: new Error("agent rebuild failed"),
        agent: closedAgent({
          send: async () => {
            hopped = true;
            return {};
          },
          deliver: () => {
            hopped = true;
          },
        }),
      });

    deliver(original.text, original.kind, original.attachments, original);
    await sessionOps.awaitTail();

    expect(hopped).toBe(false);
    expect(recovered).toEqual([original]);
    expect(notices).toEqual([CLOSED_AGENT_QUEUE_NOTICE]);
    expect(sendFailures).toEqual([]);
  });

  test("internal UUID leftover notices without restoring to composer or queue", async () => {
    const { deliver, recovered, notices, sendFailures, sessionOps } =
      routingHarness({ destination: "prompt" });

    deliver("mailbox mail — worker reports", "queue");
    await sessionOps.awaitTail();

    expect(recovered).toEqual([]);
    expect(notices).toEqual([]);
    expect(sendFailures).toHaveLength(1);
    const message =
      sendFailures[0] instanceof Error
        ? sendFailures[0].message
        : String(sendFailures[0]);
    expect(message).toBe(CLOSED_AGENT_NOTICE);
    expect(message.toLowerCase()).not.toContain("agent is closed");
  });

  test("live steer Agent.deliver throw restores, retracts steering, and notices", async () => {
    await withTestRenderer(
      async (h) => {
        const sessionOps = createSessionOperationQueue();
        const notices: string[] = [];
        const sendFailures: unknown[] = [];
        const agent = closedAgent({});
        const state = {
          fatalBuildError: null,
          sendAborted: false,
          config: { cwd: "/tmp" },
          sessionId: "s",
          inFlight: 0,
          currentAgent: agent,
          systemNotice: (text: string) => {
            notices.push(text);
          },
          handleSendFailure: (error: unknown) => {
            sendFailures.push(error);
          },
          sendWithAttemptIdentity: async (message: InboundMessage) => {
            await agent.send(message);
            return true;
          },
          host: undefined as RunnerHost | undefined,
        } as unknown as RunnerState;
        const services = {
          sessionOps,
          deliveryGeneration: createDeliveryGeneration(),
          approvalResume: {
            handle: async () => undefined,
          },
        } as unknown as RunnerServices;
        const deliver = createDeliverRouting(state, services, {
          attemptIdentity: () => ({ providerId: "p" }),
          agentProxy: agent,
        });
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const bridge = attachSessionBridge(
          shell,
          createLiveSessionPort({
            send: () => undefined,
            interrupt: () => undefined,
            deliver,
          }),
        );
        state.host = { bridge } as unknown as RunnerHost;
        try {
          bridge.submit("asap", "steer");
          const pendingId = defined(shell.session.items[0]).id;
          bridge.handle({ type: "tool.boundary" });
          expect(shell.streamLog.some((row) => row.meta === "steering")).toBe(
            true,
          );
          await sessionOps.awaitTail();
          expect(shell.session.items.map((item) => item.id)).toEqual([
            pendingId,
          ]);
          expect(defined(shell.session.items[0]).text).toBe("asap");
          expect(shell.streamLog.some((row) => row.meta === "steering")).toBe(
            false,
          );
          expect(shell.prompt.value).toBe("");
          expect(notices).toEqual([CLOSED_AGENT_QUEUE_NOTICE]);
          expect(sendFailures).toEqual([]);
          expect(notices.join("\n").toLowerCase()).not.toContain(
            "agent is closed",
          );
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("leftover hop that awaitTails the same sessionOps then rejects restores", async () => {
    const { deliver, recovered, notices, sendFailures, sessionOps } =
      routingHarness({
        destination: "prompt",
        agent: closedAgent({
          send: async () => {
            await sessionOps.awaitTail();
            throw new AgentClosedError();
          },
        }),
      });

    deliver(original.text, original.kind, original.attachments, original);
    await sessionOps.awaitTail();

    expect(recovered).toEqual([original]);
    expect(notices).toEqual([CLOSED_AGENT_PROMPT_NOTICE]);
    expect(sendFailures).toEqual([]);
  }, 2000);

  test("leftover hop that awaitTails the same sessionOps then succeeds completes", async () => {
    const sent: InboundMessage[] = [];
    const { deliver, recovered, notices, sendFailures, sessionOps } =
      routingHarness({
        destination: "prompt",
        agent: closedAgent({
          send: async (message) => {
            await sessionOps.awaitTail();
            sent.push(message);
            return {};
          },
          deliver: () => undefined,
        }),
      });

    deliver(original.text, original.kind, original.attachments, original);
    await sessionOps.awaitTail();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.content).toBe(original.text);
    expect(recovered).toEqual([]);
    expect(notices).toEqual([]);
    expect(sendFailures).toEqual([]);
  }, 2000);

  test("live steer enqueueAgentDeliver-void hop on agentProxy does not steal restore from liveAgent.deliver", async () => {
    let voidHopRan = false;
    const sessionOps = createSessionOperationQueue();
    const live = closedAgent({
      deliver: () => {
        throw new AgentClosedError();
      },
    });
    const proxy = closedAgent({
      deliver: () => {
        void sessionOps.enqueue(async () => {
          voidHopRan = true;
          throw new AgentClosedError();
        });
      },
    });
    const { deliver, recovered, notices, sendFailures } = routingHarness({
      parentCycleLive: true,
      destination: "queue",
      sessionOps,
      agent: live,
      agentProxy: proxy,
    });

    deliver(original.text, "steer", original.attachments, original);
    await sessionOps.awaitTail();

    expect(voidHopRan).toBe(false);
    expect(recovered).toEqual([original]);
    expect(notices).toEqual([CLOSED_AGENT_QUEUE_NOTICE]);
    expect(sendFailures).toEqual([]);
  }, 2000);
});
