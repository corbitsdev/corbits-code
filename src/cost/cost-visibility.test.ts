import { describe, expect, it } from "bun:test";

import { CODEX_BASE_URL } from "../auth/codex/constants.js";
import {
  costHiddenReason,
  isChatGPTSubscriptionBaseURL,
  isCodingPlanBaseURL,
  isCodingPlanProviderName,
  isFreeModelId,
} from "./cost-visibility.js";
import type { PricingCache } from "./pricing-fetcher.js";

const pricingCache: PricingCache = {
  timestamp: 0,
  models: {
    "glm-5.1": {
      inputPricePerToken: 0.000002,
      outputPricePerToken: 0.00001,
      cacheReadPricePerToken: 0,
    },
    "free-model": { inputPricePerToken: 0, outputPricePerToken: 0, cacheReadPricePerToken: 0 },
    "gpt-5.6-luna": {
      inputPricePerToken: 0.000001,
      outputPricePerToken: 0.000008,
      cacheReadPricePerToken: 0,
    },
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

  it("matches coding only as a whole path segment", () => {
    expect(isCodingPlanBaseURL("https://api.z.ai/api/coding")).toBe(true);
    expect(isCodingPlanBaseURL("https://api.example.com/v1/encoding/paas")).toBe(false);
    expect(isCodingPlanBaseURL("https://api.example.com/decoding")).toBe(false);
    expect(isCodingPlanBaseURL("https://api.example.com/coding-assistant/v1")).toBe(false);
  });

  it("does not match coding in a query string", () => {
    expect(isCodingPlanBaseURL("https://api.example.com/v1?redirect=/coding")).toBe(false);
  });

  it("handles undefined and malformed URLs without over-matching", () => {
    expect(isCodingPlanBaseURL(undefined)).toBe(false);
    expect(isCodingPlanBaseURL("not a url /coding/paas")).toBe(true);
    expect(isCodingPlanBaseURL("not a url /encoding")).toBe(false);
  });
});

describe("isCodingPlanProviderName", () => {
  it("matches the first-class Z.AI Coding Plan catalog id", () => {
    expect(isCodingPlanProviderName("zai")).toBe(true);
    expect(isCodingPlanProviderName("openai")).toBe(false);
    expect(isCodingPlanProviderName("codex/default")).toBe(false);
  });

  it("matches first-class connect instance names", () => {
    expect(isCodingPlanProviderName("zai/default")).toBe(true);
    expect(isCodingPlanProviderName("zai/work")).toBe(true);
    expect(isCodingPlanProviderName("openai/default")).toBe(false);
  });
});

describe("isChatGPTSubscriptionBaseURL", () => {
  it("detects the Codex ChatGPT subscription inference base URL", () => {
    expect(isChatGPTSubscriptionBaseURL(CODEX_BASE_URL)).toBe(true);
    expect(isChatGPTSubscriptionBaseURL(`${CODEX_BASE_URL}/`)).toBe(true);
    expect(isChatGPTSubscriptionBaseURL(`${CODEX_BASE_URL}/codex/responses`)).toBe(true);
  });

  it("does not match the metered OpenAI platform API", () => {
    expect(isChatGPTSubscriptionBaseURL("https://api.openai.com/v1")).toBe(false);
  });

  it("does not match chatgpt.com outside the backend-api path", () => {
    expect(isChatGPTSubscriptionBaseURL("https://chatgpt.com/")).toBe(false);
    expect(isChatGPTSubscriptionBaseURL("https://chatgpt.com/backend")).toBe(false);
    expect(isChatGPTSubscriptionBaseURL("https://chatgpt.com/backend-api-v2")).toBe(false);
  });

  it("matches the backend-api path case-insensitively", () => {
    expect(isChatGPTSubscriptionBaseURL("https://chatgpt.com/BACKEND-API")).toBe(true);
    expect(isChatGPTSubscriptionBaseURL("https://chatgpt.com/Backend-Api/codex/responses")).toBe(
      true,
    );
  });

  it("matches query and hash via pathname, not as part of the path prefix", () => {
    expect(isChatGPTSubscriptionBaseURL("https://chatgpt.com/backend-api?foo=1")).toBe(true);
    expect(isChatGPTSubscriptionBaseURL("https://chatgpt.com/backend-api#section")).toBe(true);
  });

  it("does not match http against the https Codex origin", () => {
    expect(isChatGPTSubscriptionBaseURL("http://chatgpt.com/backend-api")).toBe(false);
  });

  it("rejects undefined, unanchored substrings, and lookalike hosts", () => {
    expect(isChatGPTSubscriptionBaseURL(undefined)).toBe(false);
    expect(isChatGPTSubscriptionBaseURL("not a url chatgpt.com/backend-api")).toBe(false);
    expect(isChatGPTSubscriptionBaseURL("notchatgpt.com/backend-api")).toBe(false);
    expect(isChatGPTSubscriptionBaseURL("chatgpt.com/backend-api")).toBe(true);
  });
});

describe("costHiddenReason", () => {
  it("hides for a manual provider override", () => {
    expect(costHiddenReason({ modelId: "glm-5.1", providerFree: true, pricingCache })).toBe(
      "provider-free",
    );
  });

  it("hides for a coding-plan base URL", () => {
    expect(
      costHiddenReason({
        modelId: "glm-5.1",
        baseURL: "https://api.z.ai/api/coding/paas/v4",
        pricingCache,
      }),
    ).toBe("coding-plan");
  });

  it("hides on live coding-plan provider identity even when baseURL is still the metered API", () => {
    expect(
      costHiddenReason({
        modelId: "glm-5.1",
        providerName: "zai",
        baseURL: "https://api.openai.com/v1",
        pricingCache,
      }),
    ).toBe("coding-plan");
  });

  it("hides on a zai instance name even when baseURL is still the metered API", () => {
    expect(
      costHiddenReason({
        modelId: "glm-5.1",
        providerName: "zai/default",
        baseURL: "https://api.openai.com/v1",
        pricingCache,
      }),
    ).toBe("coding-plan");
  });

  it("hides on a zai instance name with a coding-plan URL", () => {
    expect(
      costHiddenReason({
        modelId: "glm-5.1",
        providerName: "zai/default",
        baseURL: "https://api.z.ai/api/coding/paas/v4",
        pricingCache,
      }),
    ).toBe("coding-plan");
  });

  it("shows cost on live non-coding-plan identity even when baseURL is still a coding-plan endpoint", () => {
    expect(
      costHiddenReason({
        modelId: "glm-5.1",
        providerName: "openai",
        baseURL: "https://api.z.ai/api/coding/paas/v4",
        pricingCache,
      }),
    ).toBeNull();
  });

  it("hides for a Codex ChatGPT subscription base URL even when the model has public rates", () => {
    expect(
      costHiddenReason({
        modelId: "gpt-5.6-luna",
        baseURL: CODEX_BASE_URL,
        pricingCache,
      }),
    ).toBe("chatgpt-subscription");
  });

  it("hides on live Codex provider identity even when baseURL is still the metered API", () => {
    expect(
      costHiddenReason({
        modelId: "gpt-5.6-luna",
        providerName: "codex/default",
        baseURL: "https://api.openai.com/v1",
        pricingCache,
      }),
    ).toBe("chatgpt-subscription");
  });

  it("shows cost on live non-Codex identity even when baseURL is still the ChatGPT backend", () => {
    expect(
      costHiddenReason({
        modelId: "gpt-5.6-luna",
        providerName: "openai",
        baseURL: CODEX_BASE_URL,
        pricingCache,
      }),
    ).toBeNull();
  });

  it("hides for a free-named model", () => {
    expect(costHiddenReason({ modelId: "qwen3:free", pricingCache })).toBe("free-model");
  });

  it("hides for a model priced at zero", () => {
    expect(costHiddenReason({ modelId: "free-model", pricingCache })).toBe("zero-priced");
  });

  it("shows cost for a normal metered model", () => {
    expect(
      costHiddenReason({
        modelId: "glm-5.1",
        baseURL: "https://api.z.ai/api/paas/v4",
        pricingCache,
      }),
    ).toBeNull();
  });

  it("shows cost for Luna on the metered OpenAI platform API", () => {
    expect(
      costHiddenReason({
        modelId: "gpt-5.6-luna",
        providerName: "openai",
        baseURL: "https://api.openai.com/v1",
        pricingCache,
      }),
    ).toBeNull();
  });

  it("shows cost for a metered OpenAI instance name", () => {
    expect(
      costHiddenReason({
        modelId: "gpt-5.6-luna",
        providerName: "openai/default",
        baseURL: "https://api.openai.com/v1",
        pricingCache,
      }),
    ).toBeNull();
  });

  it("shows cost for an unknown model with no signals", () => {
    expect(costHiddenReason({ modelId: "mystery-model", pricingCache: null })).toBeNull();
  });
});
