import { describe, expect, test } from "bun:test";
import type { TokenUsage } from "@intx/types/runtime";
import { createFaremeter } from "./faremeter.js";

const PRICES = {
  inputPricePerToken: 1,
  outputPricePerToken: 2,
  cacheReadPricePerToken: 0.5,
};

describe("createFaremeter", () => {
  test("bills uncached input at the input rate and cached reads at the cache rate", () => {
    const faremeter = createFaremeter(PRICES);
    // Normalized Responses-API usage: input excludes cached tokens (the
    // adapter subtracts them), so the same token is never billed twice.
    const usage: TokenUsage = {
      input: 80,
      output: 10,
      cacheRead: 20,
      cacheWrite: 0,
      thinking: 0,
    };

    faremeter.addUsage(usage);

    expect(faremeter.getTotalCost()).toBe(80 * 1 + 10 * 2 + 20 * 0.5);
  });

  test("reports context occupancy as the full prompt size, not just uncached input", () => {
    const faremeter = createFaremeter(PRICES);
    faremeter.addUsage({ input: 200, output: 50, cacheRead: 800, cacheWrite: 0, thinking: 0 });

    expect(faremeter.getInputTokens()).toBe(1000);
    expect(faremeter.getTotalTokens()).toBe(1050);
  });

  test("accumulates cost across turns and counts thinking tokens as output volume", () => {
    const faremeter = createFaremeter(PRICES);
    faremeter.addUsage({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0, thinking: 5 });
    faremeter.addUsage({ input: 40, output: 20, cacheRead: 60, cacheWrite: 0, thinking: 0 });

    // Thinking tokens are tracked in the cumulative output count but ride the
    // same unbilled slot today: totalCost prices usage.output only.
    expect(faremeter.getTotalCost()).toBe(100 + 2 * 10 + (40 + 2 * 20 + 30));
    expect(faremeter.getOutputTokens()).toBe(35);
  });
});
