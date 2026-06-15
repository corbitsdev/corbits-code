import { describe, expect, it } from "bun:test";

import { shouldHideCost, isCodingPlanBaseURL, isFreeModelId } from "./cost-visibility.js";
import type { PricingCache } from "./pricing-fetcher.js";

const pricingCache: PricingCache = {
  timestamp: 0,
  models: {
    "glm-5.1": { inputPricePerToken: 0.000002, outputPricePerToken: 0.00001, cacheReadPricePerToken: 0 },
    "free-model": { inputPricePerToken: 0, outputPricePerToken: 0, cacheReadPricePerToken: 0 },
  },
};

describe("isFreeModelId", () => {
  it("matches :free and -free suffixes case-insensitively", () => {
    expect(isFreeModelId("deepseek/deepseek-r1:free")).toBe(true);
    expect(isFreeModelId("some-model-free")).toBe(true);
    expect(isFreeModelId("Qwen3:FREE")).toBe(true);
  });

  it("does not match models that merely contain free", () => {
    expect(isFreeModelId("freedom-model")).toBe(false);
    expect(isFreeModelId("glm-5.1")).toBe(false);
  });
});

describe("isCodingPlanBaseURL", () => {
  it("detects /coding in the path", () => {
    expect(isCodingPlanBaseURL("https://api.z.ai/api/coding/paas/v4")).toBe(true);
  });

  it("ignores the metered API endpoint", () => {
    expect(isCodingPlanBaseURL("https://api.z.ai/api/paas/v4")).toBe(false);
  });

  it("handles undefined and malformed URLs", () => {
    expect(isCodingPlanBaseURL(undefined)).toBe(false);
    expect(isCodingPlanBaseURL("not a url /coding")).toBe(true);
  });
});

describe("shouldHideCost", () => {
  it("hides for a manual provider override", () => {
    expect(shouldHideCost({ modelId: "glm-5.1", providerFree: true, pricingCache })).toBe(true);
  });

  it("hides for a coding-plan base URL", () => {
    expect(
      shouldHideCost({ modelId: "glm-5.1", baseURL: "https://api.z.ai/api/coding/paas/v4", pricingCache }),
    ).toBe(true);
  });

  it("hides for a free-named model", () => {
    expect(shouldHideCost({ modelId: "qwen3:free", pricingCache })).toBe(true);
  });

  it("hides for a model priced at zero", () => {
    expect(shouldHideCost({ modelId: "free-model", pricingCache })).toBe(true);
  });

  it("shows cost for a normal metered model", () => {
    expect(
      shouldHideCost({ modelId: "glm-5.1", baseURL: "https://api.z.ai/api/paas/v4", pricingCache }),
    ).toBe(false);
  });

  it("shows cost for an unknown model with no signals", () => {
    expect(shouldHideCost({ modelId: "mystery-model", pricingCache: null })).toBe(false);
  });
});
