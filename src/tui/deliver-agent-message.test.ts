import { describe, expect, test } from "bun:test";
import { AgentClosedError } from "@intx/agent";
import {
  deliverAgentMessage,
  deliveryResultNotice,
  runGenerationGuardedDeliver,
} from "./delivery-queue.js";

describe("deliverAgentMessage", () => {
  test("reports session-unavailable without calling deliver when rebuild failed", async () => {
    const fatal = new Error("agent rebuild failed: provider unreachable");
    let delivered = 0;

    const result = await deliverAgentMessage({
      getFatalBuildError: () => fatal,
      deliverToLiveAgent: () => {
        delivered += 1;
      },
    });

    expect(delivered).toBe(0);
    expect(result).toEqual({
      status: "not-delivered",
      reason: "session-unavailable",
      detail: "agent rebuild failed: provider unreachable",
    });
  });

  test("classifies typed AgentClosedError as agent-closed, not by message text", async () => {
    let delivered = 0;

    const result = await deliverAgentMessage({
      getFatalBuildError: () => null,
      deliverToLiveAgent: () => {
        delivered += 1;
        throw new AgentClosedError();
      },
    });

    expect(delivered).toBe(1);
    expect(result.status).toBe("not-delivered");
    if (result.status === "not-delivered") {
      expect(result.reason).toBe("agent-closed");
    }
  });

  test("treats a plain Error whose message says agent is closed as uncertain", async () => {
    const result = await deliverAgentMessage({
      getFatalBuildError: () => null,
      deliverToLiveAgent: () => {
        throw new Error("agent is closed");
      },
    });

    expect(result).toEqual({
      status: "uncertain",
      detail: "agent is closed",
    });
  });

  test("delivers once and returns accepted when the agent is healthy", async () => {
    let delivered = 0;

    const result = await deliverAgentMessage({
      getFatalBuildError: () => null,
      deliverToLiveAgent: () => {
        delivered += 1;
      },
    });

    expect(delivered).toBe(1);
    expect(result).toEqual({ status: "accepted" });
  });
});

describe("runGenerationGuardedDeliver", () => {
  test("a reload between enqueue and execution drops the deliver without touching the agent", async () => {
    // Pins the reload-vs-async-deliver verdict: the serial op queue is FIFO
    // with no preemption, so a continuation answer queued ahead of a reload
    // still executes — the generation re-check at execution time is what
    // keeps the stale answer from reaching the replaced agent.
    let generation = 1;
    const stillCurrent = () => generation === 1;
    // Enqueue captures the closure; the reload lands before it executes.
    const queued = () =>
      runGenerationGuardedDeliver({
        stillCurrent,
        onStale: () => ({
          status: "not-delivered",
          reason: "superseded",
          detail: "session identity changed before delivery",
        }),
        run: async () => {
          delivered += 1;
          return { status: "accepted" as const };
        },
      });
    let delivered = 0;
    generation = 2;
    const stale = await queued();
    expect(stale).toEqual({
      status: "not-delivered",
      reason: "superseded",
      detail: "session identity changed before delivery",
    });
    expect(delivered).toBe(0);
  });

  test("a current deliver runs the real settle exactly once", async () => {
    let runs = 0;
    const result = await runGenerationGuardedDeliver({
      stillCurrent: () => true,
      onStale: () => ({
        status: "not-delivered",
        reason: "superseded",
        detail: "stale",
      }),
      run: async () => {
        runs += 1;
        return { status: "accepted" as const };
      },
    });
    expect(result).toEqual({ status: "accepted" });
    expect(runs).toBe(1);
  });
});

describe("deliveryResultNotice", () => {
  test("closed restored and deferred copy is actionable", () => {
    const closed = {
      status: "not-delivered" as const,
      reason: "agent-closed" as const,
      detail: "agent is closed",
    };
    expect(deliveryResultNotice(closed, "restored")).toBe(
      "Message not delivered because the agent closed. It is back in the prompt; press Enter to send it.",
    );
    expect(deliveryResultNotice(closed, "deferred")).toBe(
      "Message not delivered because the agent closed. Your current draft is unchanged; the message will return to the prompt after you send it.",
    );
  });

  test("uncertain copy does not claim nondelivery", () => {
    expect(
      deliveryResultNotice(
        { status: "uncertain", detail: "network reset" },
        "restored",
      ),
    ).toBe(
      "Delivery failed: network reset. Delivery status is uncertain; review the transcript before sending again. It is back in the prompt; press Enter to send it.",
    );
  });
});
