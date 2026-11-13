import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@intx/types/runtime";

import { createSessionOperationQueue } from "./delivery-queue.js";
import {
  ApprovalDeliveryTimeoutError,
  createApprovalDeliverer,
  createQueuedApprovalDeliver,
} from "./approval-delivery.js";
import { redactedCorrelationId } from "../session/redacted-correlation.js";

function decisionMessage(
  correlationId: string | undefined,
  outcome: "approved" | "rejected",
): InboundMessage {
  return {
    ref: { uid: 0, mailbox: "approval" },
    headers: {
      from: "approval@local",
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: `approval-${correlationId ?? "uncorrelated"}`,
      ...(correlationId !== undefined
        ? { interchangeCorrelationId: correlationId }
        : {}),
    },
    flags: [],
    content: JSON.stringify({ outcome }),
    signatureStatus: "missing",
  } satisfies InboundMessage;
}

function controllableAcceptance() {
  const waiters = new Map<string, () => void>();
  return {
    wait(correlationId: string): Promise<void> {
      return new Promise<void>((resolve) => {
        waiters.set(correlationId, () => {
          waiters.delete(correlationId);
          resolve();
        });
      });
    },
    settle(correlationId: string): void {
      waiters.get(correlationId)?.();
    },
    abandon(correlationId: string): void {
      waiters.delete(correlationId);
    },
    pendingCount(): number {
      return waiters.size;
    },
  };
}

describe("approval delivery acceptance bound", () => {
  test("a stuck acceptance wait fails fast and the sessionOps tail advances", async () => {
    const acceptance = controllableAcceptance();
    const delivered: InboundMessage[] = [];
    const deliverer = createApprovalDeliverer({
      deliverToAgent: (message) => {
        delivered.push(message);
      },
      acceptance,
      timeoutMs: 15,
    });
    const sessionOps = createSessionOperationQueue();
    const started = Date.now();

    const stuck = sessionOps.enqueue(() =>
      deliverer.deliver(decisionMessage("corr-stuck", "approved")),
    );
    let tailAdvanced = false;
    const next = sessionOps.enqueue(async () => {
      tailAdvanced = true;
    });

    const failure = await stuck.then(
      () => null,
      (err: unknown) => err,
    );
    await next;

    expect(failure).toBeInstanceOf(ApprovalDeliveryTimeoutError);
    const err = failure as ApprovalDeliveryTimeoutError;
    expect(err.correlationId).toBe("corr-stuck");
    expect(err.stage).toBe("reactor-acceptance");
    expect(err.timeoutMs).toBe(15);
    expect(err.mayStillApply).toBe(true);
    // Message text is redacted; the structured property keeps the full ID.
    expect(err.message).toContain(
      `correlationId=${redactedCorrelationId("corr-stuck")}`,
    );
    expect(err.message).not.toContain("corr-stuck,");
    expect(err.message).toContain("reactor-acceptance");
    expect(tailAdvanced).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(delivered).toHaveLength(1);
    expect(acceptance.pendingCount()).toBe(0);
  });

  test("retry after an acceptance timeout does not re-deliver a handed-over decision", async () => {
    const acceptance = controllableAcceptance();
    const delivered: InboundMessage[] = [];
    const deliverer = createApprovalDeliverer({
      deliverToAgent: (message) => {
        delivered.push(message);
      },
      acceptance,
      timeoutMs: 10,
    });
    const message = decisionMessage("corr-retry", "approved");

    await expect(deliverer.deliver(message)).rejects.toBeInstanceOf(
      ApprovalDeliveryTimeoutError,
    );
    expect(delivered).toHaveLength(1);

    const retry = deliverer.deliver(message);
    acceptance.settle("corr-retry");
    await retry;

    expect(delivered).toHaveLength(1);
  });

  test("retry after a deliver throw re-delivers: recovery from a failed send", async () => {
    const acceptance = controllableAcceptance();
    const delivered: InboundMessage[] = [];
    let failDeliver = true;
    const deliverer = createApprovalDeliverer({
      deliverToAgent: (message) => {
        if (failDeliver) throw new Error("agent is done");
        delivered.push(message);
      },
      acceptance,
      timeoutMs: 50,
    });
    const message = decisionMessage("corr-failed-send", "rejected");

    await expect(deliverer.deliver(message)).rejects.toThrow("agent is done");
    expect(delivered).toHaveLength(0);

    failDeliver = false;
    const retry = deliverer.deliver(message);
    acceptance.settle("corr-failed-send");
    await retry;

    expect(delivered).toHaveLength(1);
  });

  test("an uncorrelated decision delivers without waiting for acceptance", async () => {
    const acceptance = controllableAcceptance();
    const delivered: InboundMessage[] = [];
    const deliverer = createApprovalDeliverer({
      deliverToAgent: (message) => {
        delivered.push(message);
      },
      acceptance,
      timeoutMs: 10,
    });

    await deliverer.deliver(decisionMessage(undefined, "rejected"));

    expect(delivered).toHaveLength(1);
    expect(acceptance.pendingCount()).toBe(0);
  });

  test("timeout diagnostics name the rejected outcome and its uncertainty", async () => {
    const acceptance = controllableAcceptance();
    const delivered: InboundMessage[] = [];
    const deliverer = createApprovalDeliverer({
      deliverToAgent: (message) => {
        delivered.push(message);
      },
      acceptance,
      timeoutMs: 10,
    });

    const failure = await deliverer
      .deliver(decisionMessage("corr-reject", "rejected"))
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(failure).toBeInstanceOf(ApprovalDeliveryTimeoutError);
    const err = failure as ApprovalDeliveryTimeoutError;
    expect(err.outcome).toBe("rejected");
    expect(err.mayStillApply).toBe(true);
    expect(err.message).toContain("rejected");
  });
});

describe("queued approval deliver", () => {
  function queuedDeliver(fatal: Error | null = null) {
    const delivered: InboundMessage[] = [];
    const deliver = createQueuedApprovalDeliver({
      enqueue: createSessionOperationQueue().enqueue,
      fatalBuildError: () => fatal,
      deliverer: {
        deliver: async (message) => {
          delivered.push(message);
        },
      },
    });
    return { deliver, delivered };
  }

  test("reports a decision the session still wants as delivered", async () => {
    const { deliver, delivered } = queuedDeliver();
    const message = decisionMessage("corr-1", "rejected");

    expect(await deliver(message, () => true)).toBe("delivered");
    expect(delivered).toEqual([message]);
  });

  test("reports a decision the session moved past while it waited as skipped", async () => {
    const { deliver, delivered } = queuedDeliver();

    expect(
      await deliver(decisionMessage("corr-1", "rejected"), () => false),
    ).toBe("skipped");
    expect(delivered).toEqual([]);
  });

  test("throws the build error instead of delivering to a failed agent", async () => {
    const { deliver, delivered } = queuedDeliver(new Error("build failed"));

    await expect(
      deliver(decisionMessage("corr-1", "rejected"), () => true),
    ).rejects.toThrow("build failed");
    expect(delivered).toEqual([]);
  });
});
