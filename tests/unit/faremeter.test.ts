import { test, expect } from "bun:test";
import { createFaremeter, formatCost } from "../../src/faremeter.js";

test("createFaremeter starts at zero", () => {
  const faremeter = createFaremeter();
  expect(faremeter.getTotalCost()).toBe(0);
  expect(faremeter.getTotalTokens()).toBe(0);
});

test("addUsage accumulates tokens and cost", () => {
  const faremeter = createFaremeter();
  faremeter.addUsage({ input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, thinking: 0 });
  expect(faremeter.getTotalTokens()).toBe(1500);
});

test("addUsage computes cost from input and output tokens", () => {
  const faremeter = createFaremeter({ inputPricePerToken: 0.00001, outputPricePerToken: 0.00002 });
  faremeter.addUsage({ input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, thinking: 0 });
  expect(faremeter.getTotalCost()).toBe(0.02);
});

test("createFaremeter uses fetched model rates", () => {
  const faremeter = createFaremeter({
    modelId: "provider/model",
    pricingCache: {
      timestamp: 1,
      models: {
        "provider/model": {
          inputPricePerToken: 0.00001,
          outputPricePerToken: 0.00002,
          cacheReadPricePerToken: 0.000005,
        },
      },
    },
  });

  faremeter.addUsage({ input: 1000, output: 500, cacheRead: 200, cacheWrite: 0, thinking: 0 });

  expect(faremeter.getTotalCost()).toBe(0.021);
});

test("formatCost formats to 4 decimal places with dollar sign", () => {
  expect(formatCost(0.023456)).toBe("$0.0235");
  expect(formatCost(0)).toBe("$0.0000");
  expect(formatCost(1.5)).toBe("$1.5000");
});

test("multiple addUsage calls accumulate", () => {
  const faremeter = createFaremeter({ inputPricePerToken: 0.00001, outputPricePerToken: 0.00002 });
  faremeter.addUsage({ input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, thinking: 0 });
  faremeter.addUsage({ input: 2000, output: 1000, cacheRead: 0, cacheWrite: 0, thinking: 0 });
  expect(faremeter.getTotalTokens()).toBe(4500);
  expect(faremeter.getTotalCost()).toBe(0.06);
});
