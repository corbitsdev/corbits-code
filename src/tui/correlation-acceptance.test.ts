import { describe, test } from "bun:test";

import { createCorrelationAcceptance } from "./correlation-acceptance.js";

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
});
