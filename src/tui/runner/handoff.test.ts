import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@intx/types/runtime";
import type { AgentDeliveryResult } from "../delivery-queue.js";
import { HANDOFF_DEFAULT_PIVOT, createCommandLayer } from "./commands.js";
import type { RunnerServices, RunnerState } from "./state.js";

type Arming = "armed" | "noop";

interface HandoffHarness {
  requestHandoff: (instructions: string) => string | undefined;
  sent: InboundMessage[];
  requested: string[];
  cancelled: number;
  setArming: (arming: Arming) => void;
  setSendResult: (result: AgentDeliveryResult) => void;
  setSendThrows: (message: string) => void;
}

function setUpHandoffHarness(options?: {
  director?: boolean;
  send?: boolean;
}): HandoffHarness {
  const sent: InboundMessage[] = [];
  const requested: string[] = [];
  let cancelled = 0;
  let arming: Arming = "armed";
  let sendResult: AgentDeliveryResult = { status: "accepted" };
  let sendError: string | undefined;

  const director = {
    requestHandoff: (instructions: string): Arming => {
      requested.push(instructions);
      return arming;
    },
    cancelManualCompact: () => {
      cancelled++;
    },
  };
  const state = {
    ...(options?.send === false
      ? {}
      : {
          sendWithAttemptIdentity: async (
            message: InboundMessage,
          ): Promise<AgentDeliveryResult> => {
            sent.push(message);
            if (sendError !== undefined) throw new Error(sendError);
            return sendResult;
          },
        }),
  } as unknown as RunnerState;
  const services = {
    directorHolder: options?.director === false ? {} : { instance: director },
  } as unknown as RunnerServices;
  const { commandContext } = createCommandLayer(state, services);
  const requestHandoff = (instructions: string): string | undefined => {
    if (commandContext.requestHandoff === undefined) {
      throw new Error("requestHandoff was not wired");
    }
    return commandContext.requestHandoff(instructions);
  };
  return {
    requestHandoff,
    sent,
    requested,
    get cancelled() {
      return cancelled;
    },
    setArming: (next: Arming) => {
      arming = next;
    },
    setSendResult: (result: AgentDeliveryResult) => {
      sendResult = result;
    },
    setSendThrows: (message: string) => {
      sendError = message;
    },
  };
}

const flushSends = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("runner /handoff wiring", () => {
  test("armed handoff delivers the trimmed instructions as the next turn", async () => {
    const h = setUpHandoffHarness();
    expect(h.requestHandoff("  now do the UI audit  ")).toBeUndefined();
    expect(h.requested).toEqual(["  now do the UI audit  "]);
    await flushSends();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.content).toBe("now do the UI audit");
    expect(h.cancelled).toBe(0);
  });

  test("armed handoff without instructions delivers the default pivot copy", async () => {
    const h = setUpHandoffHarness();
    expect(h.requestHandoff("")).toBeUndefined();
    await flushSends();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.content).toBe(HANDOFF_DEFAULT_PIVOT);
    expect(HANDOFF_DEFAULT_PIVOT.length).toBeGreaterThan(0);
    expect(h.cancelled).toBe(0);
  });

  test("noop fold with instructions still pivots to the new goal", async () => {
    const h = setUpHandoffHarness();
    h.setArming("noop");
    expect(h.requestHandoff("ship the dashboard")).toBeUndefined();
    await flushSends();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.content).toBe("ship the dashboard");
    expect(h.cancelled).toBe(0);
  });

  test("noop fold without instructions reports instead of sending a blank pivot", async () => {
    const h = setUpHandoffHarness();
    h.setArming("noop");
    expect(h.requestHandoff("")).toBe(
      "Nothing to hand off yet — the conversation is too short to fold.",
    );
    await flushSends();
    expect(h.sent).toHaveLength(0);
  });

  test("an undelivered pivot disarms so the next message does not fold", async () => {
    const h = setUpHandoffHarness();
    h.setSendResult({
      status: "not-delivered",
      reason: "agent-closed",
      detail: "closed",
    });
    expect(h.requestHandoff("now do the UI audit")).toBeUndefined();
    await flushSends();
    expect(h.sent).toHaveLength(1);
    expect(h.cancelled).toBe(1);
  });

  test("an undelivered noop pivot does not cancelManualCompact", async () => {
    const h = setUpHandoffHarness();
    h.setArming("noop");
    h.setSendResult({
      status: "not-delivered",
      reason: "agent-closed",
      detail: "closed",
    });
    expect(h.requestHandoff("ship the dashboard")).toBeUndefined();
    await flushSends();
    expect(h.sent).toHaveLength(1);
    expect(h.cancelled).toBe(0);
  });

  test("a rejected noop pivot send does not cancelManualCompact", async () => {
    const h = setUpHandoffHarness();
    h.setArming("noop");
    h.setSendThrows("boom");
    expect(h.requestHandoff("ship the dashboard")).toBeUndefined();
    await flushSends();
    expect(h.cancelled).toBe(0);
  });

  test("a rejected pivot send disarms as well", async () => {
    const h = setUpHandoffHarness();
    h.setSendThrows("boom");
    expect(h.requestHandoff("now do the UI audit")).toBeUndefined();
    await flushSends();
    expect(h.cancelled).toBe(1);
  });

  test("says so when no director is mounted", () => {
    const h = setUpHandoffHarness({ director: false });
    expect(h.requestHandoff("x")).toBe(
      "Handoff is not available in this session.",
    );
    expect(h.sent).toHaveLength(0);
  });

  test("says so when the send path is not wired", () => {
    const h = setUpHandoffHarness({ send: false });
    expect(h.requestHandoff("x")).toBe(
      "Handoff is not available in this session.",
    );
  });
});
