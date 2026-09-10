import { describe, expect, test } from "bun:test";

import { createCorrelationAcceptance } from "./correlation-acceptance.js";

function approvedMessage(correlationId: string) {
  return {
    headers: { interchangeCorrelationId: correlationId },
    content: JSON.stringify({ outcome: "approved" }),
  };
}

function rejectedMessage(correlationId: string) {
  return {
    headers: { interchangeCorrelationId: correlationId },
    content: JSON.stringify({ outcome: "rejected" }),
  };
}

describe("createCorrelationAcceptance", () => {
  test("settle resolves the waiter for that correlation id", async () => {
    const acceptance = createCorrelationAcceptance();
    const pending = acceptance.wait("corr-1");
    acceptance.settle("corr-1");
    await pending;
  });

  test("settleAll releases every outstanding waiter", async () => {
    const acceptance = createCorrelationAcceptance();
    const first = acceptance.wait("a");
    const second = acceptance.wait("b");
    acceptance.settleAll();
    await Promise.all([first, second]);
  });

  test("settle of an unknown id is a no-op", () => {
    const acceptance = createCorrelationAcceptance();
    acceptance.settle("missing");
  });

  test("an approved correlation does not settle until tool.start", async () => {
    const acceptance = createCorrelationAcceptance();
    const pending = acceptance.wait("corr-1");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    acceptance.observe({
      type: "message.correlated",
      data: { correlationId: "corr-1", message: approvedMessage("corr-1") },
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    acceptance.observe({
      type: "tool.start",
      data: { call: { id: "call-1" } },
    });
    await pending;
    expect(settled).toBe(true);
  });

  test("a rejected correlation settles at message.correlated", async () => {
    const acceptance = createCorrelationAcceptance();
    const pending = acceptance.wait("corr-1");
    acceptance.observe({
      type: "message.correlated",
      data: { correlationId: "corr-1", message: rejectedMessage("corr-1") },
    });
    await pending;
  });
});
