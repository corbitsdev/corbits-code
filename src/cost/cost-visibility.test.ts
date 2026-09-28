import { describe, expect, it } from "bun:test";

import { CODEX_BASE_URL } from "../auth/codex/constants.js";
import {
  costHiddenReason,
  isChatGPTSubscriptionBaseURL,
  isCodingPlanBaseURL,
  isCodingPlanProviderName,
  isFreeModelId,
  type CostVisibilityInput,
} from "./cost-visibility.js";
import { testPricingCache as pricingCache } from "./pricing-test-fixture.js";

describe("isFreeModelId", () => {
  const cases: [string, boolean][] = [
    ["deepseek/deepseek-r1:free", true],
    ["some-model-free", true],
    ["Qwen3:FREE", true],
    // must not match models that merely contain "free"
    ["freedom-model", false],
    ["glm-5.1", false],
  ];
  it("matches :free and -free suffixes case-insensitively only", () => {
    for (const [modelId, expected] of cases) {
      expect(isFreeModelId(modelId)).toBe(expected);
    }
  });
});

describe("isCodingPlanBaseURL", () => {
  const cases: [string | undefined, boolean][] = [
    // "coding" counts only as a whole path segment
    ["https://api.z.ai/api/coding/paas/v4", true],
    ["https://api.z.ai/api/coding", true],
    ["https://api.z.ai/api/paas/v4", false],
    ["https://api.example.com/v1/encoding/paas", false],
    ["https://api.example.com/decoding", false],
    ["https://api.example.com/coding-assistant/v1", false],
    // query string is not part of the path
    ["https://api.example.com/v1?redirect=/coding", false],
    // malformed input still splits on segments without over-matching
    [undefined, false],
    ["not a url /coding/paas", true],
    ["not a url /encoding", false],
  ];
  it("matches coding only as a whole path segment", () => {
    for (const [url, expected] of cases) {
      expect(isCodingPlanBaseURL(url)).toBe(expected);
    }
  });
});

describe("isCodingPlanProviderName", () => {
  const cases: [string, boolean][] = [
    // first-class Z.AI Coding Plan catalog id and connect instance names
    ["zai", true],
    ["zai/default", true],
    ["zai/work", true],
    ["openai", false],
    ["codex/default", false],
    ["openai/default", false],
  ];
  it("matches zai provider and instance names only", () => {
    for (const [name, expected] of cases) {
      expect(isCodingPlanProviderName(name)).toBe(expected);
    }
  });
});

describe("isChatGPTSubscriptionBaseURL", () => {
  const cases: [string | undefined, boolean][] = [
    // the Codex ChatGPT subscription inference base URL and sub-paths
    [CODEX_BASE_URL, true],
    [`${CODEX_BASE_URL}/`, true],
    [`${CODEX_BASE_URL}/codex/responses`, true],
    // the metered OpenAI platform API is not a subscription endpoint
    ["https://api.openai.com/v1", false],
    // chatgpt.com outside the backend-api path
    ["https://chatgpt.com/", false],
    ["https://chatgpt.com/backend", false],
    ["https://chatgpt.com/backend-api-v2", false],
    // backend-api path matches case-insensitively, on the pathname
    ["https://chatgpt.com/BACKEND-API", true],
    ["https://chatgpt.com/Backend-Api/codex/responses", true],
    ["https://chatgpt.com/backend-api?foo=1", true],
    ["https://chatgpt.com/backend-api#section", true],
    // no http against the https Codex origin
    ["http://chatgpt.com/backend-api", false],
    // undefined, unanchored substrings, and lookalike hosts
    [undefined, false],
    ["not a url chatgpt.com/backend-api", false],
    ["notchatgpt.com/backend-api", false],
    ["chatgpt.com/backend-api", true],
  ];
  it("matches only the backend-api path on the Codex origin", () => {
    for (const [url, expected] of cases) {
      expect(isChatGPTSubscriptionBaseURL(url)).toBe(expected);
    }
  });
});

describe("costHiddenReason", () => {
  type Row = Omit<CostVisibilityInput, "pricingCache"> & {
    pricingCache?: CostVisibilityInput["pricingCache"];
  };
  const cases: {
    input: Row;
    expected: ReturnType<typeof costHiddenReason>;
  }[] = [
    {
      input: { modelId: "glm-5.1", providerFree: true },
      expected: "provider-free",
    },
    {
      input: {
        modelId: "glm-5.1",
        baseURL: "https://api.z.ai/api/coding/paas/v4",
      },
      expected: "coding-plan",
    },
    // live coding-plan identity wins even when baseURL is still the metered API
    {
      input: {
        modelId: "glm-5.1",
        providerName: "zai",
        baseURL: "https://api.openai.com/v1",
      },
      expected: "coding-plan",
    },
    {
      input: {
        modelId: "glm-5.1",
        providerName: "zai/default",
        baseURL: "https://api.openai.com/v1",
      },
      expected: "coding-plan",
    },
    {
      input: {
        modelId: "glm-5.1",
        providerName: "zai/default",
        baseURL: "https://api.z.ai/api/coding/paas/v4",
      },
      expected: "coding-plan",
    },
    // live non-coding-plan identity wins even on a coding-plan endpoint
    {
      input: {
        modelId: "glm-5.1",
        providerName: "openai",
        baseURL: "https://api.z.ai/api/coding/paas/v4",
      },
      expected: null,
    },
    {
      input: { modelId: "gpt-5.6-luna", baseURL: CODEX_BASE_URL },
      expected: "chatgpt-subscription",
    },
    // live Codex identity wins even when baseURL is still the metered API
    {
      input: {
        modelId: "gpt-5.6-luna",
        providerName: "codex/default",
        baseURL: "https://api.openai.com/v1",
      },
      expected: "chatgpt-subscription",
    },
    // live non-Codex identity wins even on the ChatGPT backend
    {
      input: {
        modelId: "gpt-5.6-luna",
        providerName: "openai",
        baseURL: CODEX_BASE_URL,
      },
      expected: null,
    },
    { input: { modelId: "qwen3:free" }, expected: "free-model" },
    { input: { modelId: "free-model" }, expected: "zero-priced" },
    {
      input: {
        modelId: "glm-5.1",
        baseURL: "https://api.z.ai/api/paas/v4",
      },
      expected: null,
    },
    {
      input: {
        modelId: "gpt-5.6-luna",
        providerName: "openai",
        baseURL: "https://api.openai.com/v1",
      },
      expected: null,
    },
    {
      input: {
        modelId: "gpt-5.6-luna",
        providerName: "openai/default",
        baseURL: "https://api.openai.com/v1",
      },
      expected: null,
    },
    {
      input: { modelId: "mystery-model", pricingCache: null },
      expected: null,
    },
  ];
  it("maps model/provider signals to a hidden reason or null", () => {
    for (const { input, expected } of cases) {
      expect(costHiddenReason({ pricingCache, ...input })).toBe(expected);
    }
  });
});
