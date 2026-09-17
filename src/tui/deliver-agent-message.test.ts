import { describe, expect, test } from "bun:test";
import { AgentClosedError } from "@intx/agent";
import {
  createDeliveryGeneration,
  createSessionOperationQueue,
  deliverAgentMessage,
  deliveryResultNotice,
  enqueueCompactionContinuationHop,
  runGenerationGuardedDeliver,
  settleCompactionContinuationHop,
} from "./delivery-queue.js";
import { startInterruptRebuild } from "./runner/exit.js";

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

describe("settleCompactionContinuationHop", () => {
  test("a superseded hop does not deliver to the outgoing agent", async () => {
    let generation = 1;
    const stillCurrent = () => generation === 1;
    let delivered = 0;
    let requeued = 0;
    generation = 2;
    const result = await settleCompactionContinuationHop({
      stillCurrent,
      deliver: async () => {
        delivered += 1;
        return { status: "accepted" as const };
      },
      onSuperseded: () => {
        requeued += 1;
      },
    });
    expect(result).toEqual({
      status: "not-delivered",
      reason: "superseded",
      detail: "session identity changed before delivery",
    });
    expect(delivered).toBe(0);
    expect(requeued).toBe(1);
  });

  test("a closed hop re-issues the continue once", async () => {
    let attempts = 0;
    const result = await settleCompactionContinuationHop({
      stillCurrent: () => true,
      deliver: async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            status: "not-delivered" as const,
            reason: "agent-closed" as const,
            detail: "agent is closed",
          };
        }
        return { status: "accepted" as const };
      },
      onSuperseded: () => {
        throw new Error("closed hop must not requeue as superseded");
      },
    });
    expect(result).toEqual({ status: "accepted" });
    expect(attempts).toBe(2);
  });

  test("a current hop delivers once and does not re-issue", async () => {
    let runs = 0;
    const result = await settleCompactionContinuationHop({
      stillCurrent: () => true,
      deliver: async () => {
        runs += 1;
        return { status: "accepted" as const };
      },
      onSuperseded: () => {
        throw new Error("current hop must not requeue");
      },
    });
    expect(result).toEqual({ status: "accepted" });
    expect(runs).toBe(1);
  });

  test("an accepted hop stays accepted if generation flips after deliver", async () => {
    let generation = 1;
    const result = await settleCompactionContinuationHop({
      stillCurrent: () => generation === 1,
      deliver: async () => {
        generation = 2;
        return { status: "accepted" as const };
      },
      onSuperseded: () => {
        throw new Error("accepted hop must not be relabeled superseded");
      },
    });
    expect(result).toEqual({ status: "accepted" });
  });

  test("a closed hop that goes stale does not retry deliver", async () => {
    let generation = 1;
    let attempts = 0;
    const result = await settleCompactionContinuationHop({
      stillCurrent: () => generation === 1,
      deliver: async () => {
        attempts += 1;
        generation = 2;
        return {
          status: "not-delivered" as const,
          reason: "agent-closed" as const,
          detail: "agent is closed",
        };
      },
      onSuperseded: () => undefined,
    });
    expect(result).toEqual({
      status: "not-delivered",
      reason: "superseded",
      detail: "session identity changed before delivery",
    });
    expect(attempts).toBe(1);
  });

  test("continuation enqueued then interrupt rebuild queued does not auto-deliver to the replacement agent", async () => {
    const { enqueue, enqueuePreemptible, abortInFlight, awaitTail } =
      createSessionOperationQueue();
    const deliveryGeneration = createDeliveryGeneration();
    let agent = "outgoing";
    const deliveredTo: string[] = [];
    const order: string[] = [];

    enqueueCompactionContinuationHop({
      enqueue: enqueuePreemptible,
      captureGeneration: () => deliveryGeneration.capture(),
      deliver: async () => {
        deliveredTo.push(agent);
        return { status: "accepted" as const };
      },
      onResult: () => undefined,
    });

    startInterruptRebuild({
      deliveryGeneration: {
        bump: () => {
          order.push("bump");
          deliveryGeneration.bump();
        },
      },
      markSendAborted: () => undefined,
      abortInFlight: () => {
        order.push("abortInFlight");
        abortInFlight();
      },
      enqueue: (op) => {
        order.push("enqueue");
        return enqueue(op);
      },
      rebuild: async () => {
        agent = "replacement";
      },
    });

    expect(order[0]).toBe("bump");
    expect(order.indexOf("abortInFlight")).toBeGreaterThan(
      order.indexOf("bump"),
    );
    expect(order.indexOf("enqueue")).toBeGreaterThan(
      order.indexOf("abortInFlight"),
    );

    await awaitTail();
    expect(deliveredTo).not.toContain("outgoing");
    expect(deliveredTo).not.toContain("replacement");
  });

  test("hung hop then startInterruptRebuild runs rebuild without delivering to the outgoing agent", async () => {
    const { enqueue, enqueuePreemptible, abortInFlight, awaitTail } =
      createSessionOperationQueue();
    const deliveryGeneration = createDeliveryGeneration();
    let hopStarted = false;
    let rebuilt = false;
    const deliveredTo: string[] = [];

    enqueueCompactionContinuationHop({
      enqueue: enqueuePreemptible,
      captureGeneration: () => deliveryGeneration.capture(),
      deliver: async () => {
        hopStarted = true;
        await new Promise<void>(() => undefined);
        deliveredTo.push("outgoing");
        return { status: "accepted" as const };
      },
      onResult: () => undefined,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(hopStarted).toBe(true);

    startInterruptRebuild({
      deliveryGeneration,
      markSendAborted: () => undefined,
      abortInFlight,
      enqueue,
      rebuild: async () => {
        rebuilt = true;
      },
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        awaitTail(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error("rebuild did not run; hung hop parked the tail"),
              ),
            250,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    expect(rebuilt).toBe(true);
    expect(deliveredTo).toEqual([]);
  });

  test("stall-abort of a hung continuation does not requeue onto the replacement agent", async () => {
    const { enqueue, enqueuePreemptible, abortInFlight, awaitTail } =
      createSessionOperationQueue();
    const deliveryGeneration = createDeliveryGeneration();
    let settleDeliver:
      | ((result: {
          status: "not-delivered";
          reason: "agent-closed";
          detail: string;
        }) => void)
      | undefined;
    let deliverCalls = 0;
    let hopStarted = false;
    let rebuilt = false;

    enqueueCompactionContinuationHop({
      enqueue: enqueuePreemptible,
      captureGeneration: () => deliveryGeneration.capture(),
      deliver: async () => {
        deliverCalls += 1;
        hopStarted = true;
        return await new Promise((resolve) => {
          settleDeliver = resolve;
        });
      },
      onResult: () => undefined,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(hopStarted).toBe(true);

    deliveryGeneration.bump();
    abortInFlight();
    enqueue(async () => {
      rebuilt = true;
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        awaitTail(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("stall abort left the tail parked")),
            250,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    expect(rebuilt).toBe(true);
    settleDeliver?.({
      status: "not-delivered",
      reason: "agent-closed",
      detail: "agent is closed",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(deliverCalls).toBe(1);
  });

  test("two distinct continuation seqs both enqueue", async () => {
    const { enqueuePreemptible, awaitTail } = createSessionOperationQueue();
    const deliveryGeneration = createDeliveryGeneration();
    const delivered: number[] = [];

    enqueueCompactionContinuationHop({
      enqueue: enqueuePreemptible,
      captureGeneration: () => deliveryGeneration.capture(),
      deliver: async () => {
        delivered.push(1);
        return { status: "accepted" as const };
      },
      onResult: () => undefined,
    });
    enqueueCompactionContinuationHop({
      enqueue: enqueuePreemptible,
      captureGeneration: () => deliveryGeneration.capture(),
      deliver: async () => {
        delivered.push(2);
        return { status: "accepted" as const };
      },
      onResult: () => undefined,
    });

    await awaitTail();
    expect(delivered).toEqual([1, 2]);
  });

  test("an interrupt-stale hop does not report not-delivered", async () => {
    const { enqueue, enqueuePreemptible, abortInFlight, awaitTail } =
      createSessionOperationQueue();
    const deliveryGeneration = createDeliveryGeneration();
    const notices: string[] = [];

    enqueueCompactionContinuationHop({
      enqueue: enqueuePreemptible,
      captureGeneration: () => deliveryGeneration.capture(),
      deliver: async () => ({ status: "accepted" as const }),
      onResult: (result) => {
        if (result.status === "accepted") return;
        notices.push(result.detail);
      },
    });

    startInterruptRebuild({
      deliveryGeneration,
      markSendAborted: () => undefined,
      abortInFlight,
      enqueue,
      rebuild: async () => undefined,
    });

    await awaitTail();
    expect(notices).toEqual([]);
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
