import { describe, expect, test } from "bun:test";
import {
  GATEWAY_OVERLOAD_USER_MESSAGE,
  isGatewayOverloadInferenceError,
  looksLikeHtmlGatewayBody,
  normalizeInferenceErrorForRetry,
} from "./inference-gateway-error.js";

const CLOUDFLARE_503_HTML = `<!DOCTYPE html>
<html><head><title>503 Service Temporarily Unavailable</title></head>
<body><h1>503 Service Temporarily Unavailable</h1>
<p>Cloudflare Ray ID: abc</p></body></html>`;

describe("looksLikeHtmlGatewayBody", () => {
  test("detects doctype HTML", () => {
    expect(looksLikeHtmlGatewayBody(CLOUDFLARE_503_HTML)).toBe(true);
  });

  test("rejects JSON", () => {
    expect(looksLikeHtmlGatewayBody('{"error":"x"}')).toBe(false);
  });
});

describe("isGatewayOverloadInferenceError", () => {
  test("protocol_mismatch with HTML 503 body", () => {
    expect(
      isGatewayOverloadInferenceError({
        category: "protocol_mismatch",
        message: "openai parseResponse: malformed JSON in SSE data payload: Unexpected token '<'",
        raw: CLOUDFLARE_503_HTML,
      }),
    ).toBe(true);
  });

  test("protocol_mismatch with benign bad chunk is not gateway overload", () => {
    expect(
      isGatewayOverloadInferenceError({
        category: "protocol_mismatch",
        message: "openai parseResponse: SSE chunk failed schema validation",
        raw: { not: "html" },
      }),
    ).toBe(false);
  });

  test("HTTP 503 retryable with HTML raw still counts as gateway overload for messaging", () => {
    expect(
      isGatewayOverloadInferenceError({
        category: "retryable",
        message: "truncated html…",
        statusCode: 503,
        raw: CLOUDFLARE_503_HTML,
      }),
    ).toBe(true);
  });
});

describe("normalizeInferenceErrorForRetry", () => {
  test("maps protocol_mismatch gateway HTML to retryable", () => {
    const normalized = normalizeInferenceErrorForRetry({
      category: "protocol_mismatch",
      message: "malformed JSON",
      raw: CLOUDFLARE_503_HTML,
    });
    expect(normalized.category).toBe("retryable");
    expect(normalized.message).toBe(GATEWAY_OVERLOAD_USER_MESSAGE);
    expect(normalized.statusCode).toBe(503);
  });

  test("leaves unrelated errors unchanged", () => {
    const err = { category: "fatal" as const, message: "bad request" };
    expect(normalizeInferenceErrorForRetry(err)).toEqual(err);
  });

  test("maps GoUsageLimitError 429 to quota_exhausted", () => {
    const normalized = normalizeInferenceErrorForRetry({
      category: "retryable",
      message: "rate limited",
      statusCode: 429,
      raw: {
        type: "error",
        error: { type: "GoUsageLimitError", message: "subscription quota exceeded" },
      },
      retryAfterMs: 60_000,
    });
    expect(normalized.category).toBe("quota_exhausted");
    expect(normalized.message.toLowerCase()).toContain("quota");
  });

  test("maps provider rate limit 400 quirk to retryable", () => {
    const normalized = normalizeInferenceErrorForRetry({
      category: "fatal",
      message: "bad request",
      statusCode: 400,
      raw: {
        error: {
          message: "Error from provider (Console Go): Provider rate limit exceeded",
          type: "rate_limit_error",
          code: "provider_rate_limit_exceeded",
        },
      },
    });
    expect(normalized.category).toBe("retryable");
    expect(normalized.message.toLowerCase()).toMatch(/rate limit/);
  });

  test("maps GoUsageLimitError on 400 to quota_exhausted", () => {
    const normalized = normalizeInferenceErrorForRetry({
      category: "fatal",
      message: "bad request",
      statusCode: 400,
      raw: {
        type: "error",
        error: { type: "GoUsageLimitError", message: "weekly limit hit" },
      },
    });
    expect(normalized.category).toBe("quota_exhausted");
  });

  test("does not reclassify non-Go provider_rate_limit_exceeded bodies", () => {
    const err = {
      category: "fatal" as const,
      message: "rate limited",
      statusCode: 400,
      raw: {
        error: {
          message: "Provider rate limit exceeded",
          type: "rate_limit_error",
          code: "provider_rate_limit_exceeded",
        },
      },
    };
    expect(normalizeInferenceErrorForRetry(err)).toEqual(err);
  });

  test("known-Go bare 429 without Console Go markers reclassifies as rate_limit", () => {
    // intx defaults 429 → quota_exhausted; without body markers the old path
    // left that category in place. Known-Go context must reclassify.
    const bare = {
      category: "quota_exhausted" as const,
      message: "Too Many Requests",
      statusCode: 429,
      raw: { error: { message: "Too Many Requests" } },
    };

    // Without Go context, leave intx's classification alone.
    expect(normalizeInferenceErrorForRetry(bare)).toEqual(bare);

    const viaRequestURL = normalizeInferenceErrorForRetry({
      ...bare,
      requestURL: "https://opencode.ai/zen/go/v1/chat/completions",
    });
    expect(viaRequestURL.category).toBe("retryable");
    // Bare 429 keeps the original message and appends a short retry hint.
    expect(viaRequestURL.message.toLowerCase()).toMatch(/too many requests|rate limit/);

    const viaProviderId = normalizeInferenceErrorForRetry({
      ...bare,
      providerId: "opencode-go",
    });
    expect(viaProviderId.category).toBe("retryable");

    const viaFlag = normalizeInferenceErrorForRetry({
      ...bare,
      opencodeGo: true,
    });
    expect(viaFlag.category).toBe("retryable");
  });

  test("403 with usage-limit body reclassifies as quota_exhausted", () => {
    const normalized = normalizeInferenceErrorForRetry({
      category: "credential_failure",
      message: "forbidden",
      statusCode: 403,
      raw: {
        type: "error",
        error: { type: "GoUsageLimitError", message: "subscription usage limit reached" },
      },
    });
    expect(normalized.category).toBe("quota_exhausted");
    expect(normalized.message.toLowerCase()).toMatch(/usage limit|quota/);
  });

  test("maps Codex usage_limit_reached detail.error body to quota_exhausted with reset ETA", () => {
    const liveBody = {
      detail: {
        error: {
          code: "usage_limit_reached",
          message: "You have reached your usage limit. Try again later.",
          plan_type: "workspace_member",
          resets_in_seconds: 3435,
        },
      },
    };
    const normalized = normalizeInferenceErrorForRetry({
      category: "quota_exhausted",
      message: "Too Many Requests",
      statusCode: 429,
      raw: liveBody,
      providerId: "codex/abk-labs",
    });
    expect(normalized.category).toBe("quota_exhausted");
    expect(normalized.retryAfterMs).toBe(3_435_000);
    expect(normalized.message).toContain('Codex profile "abk-labs"');
    expect(normalized.message).toContain("workspace member");
    expect(normalized.message).toMatch(/Resets in ~/);
    expect(normalized.message).toContain("/model");
  });

  test("Codex usage limit without profile still formats plan and switch path", () => {
    const normalized = normalizeInferenceErrorForRetry({
      category: "retryable",
      message: "Too Many Requests",
      statusCode: 429,
      raw: JSON.stringify({
        detail: {
          error: {
            code: "usage_limit_reached",
            message: "limit",
            plan_type: "plus",
            resets_in_seconds: 120,
          },
        },
      }),
    });
    expect(normalized.category).toBe("quota_exhausted");
    expect(normalized.retryAfterMs).toBe(120_000);
    expect(normalized.message.startsWith("Codex usage limit reached")).toBe(true);
    expect(normalized.message).toContain("~2m");
  });

  test("does not rebrand OpenAI insufficient_quota as Codex", () => {
    const error = {
      category: "quota_exhausted" as const,
      message: "You exceeded your current quota, please check your plan and billing details.",
      statusCode: 429,
      raw: {
        error: {
          message: "You exceeded your current quota, please check your plan and billing details.",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      },
    };
    const normalized = normalizeInferenceErrorForRetry(error);
    expect(normalized).toBe(error);
    expect(normalized.message).not.toContain("Codex");
  });

  test("skips Codex rebrand when providerId is known non-Codex", () => {
    const error = {
      category: "retryable" as const,
      message: "Too Many Requests",
      statusCode: 429,
      providerId: "openai",
      raw: {
        detail: {
          error: {
            code: "usage_limit_reached",
            message: "limit",
            plan_type: "plus",
            resets_in_seconds: 120,
          },
        },
      },
    };
    const normalized = normalizeInferenceErrorForRetry(error);
    expect(normalized).toBe(error);
  });

  test("known-xAI bare 429 reclassifies as retryable", () => {
    const bare = {
      category: "quota_exhausted" as const,
      message: "Too Many Requests",
      statusCode: 429,
      retryAfterMs: 45_000,
      raw: { error: { message: "Too Many Requests" } },
    };

    // Without xAI context, leave intx's classification alone.
    expect(normalizeInferenceErrorForRetry(bare)).toEqual(bare);

    const viaProviderId = normalizeInferenceErrorForRetry({
      ...bare,
      providerId: "xai/thegreataxios",
    });
    expect(viaProviderId.category).toBe("retryable");
    expect(viaProviderId.retryAfterMs).toBe(45_000);
    expect(viaProviderId.message.toLowerCase()).toMatch(/rate limit/);
  });

  test("known-xAI 429 with usage/quota body stays quota_exhausted", () => {
    const normalized = normalizeInferenceErrorForRetry({
      category: "quota_exhausted",
      message: "Too Many Requests",
      statusCode: 429,
      providerId: "xai/thegreataxios",
      retryAfterMs: 86_400_000,
      raw: {
        error: {
          message: "You exceeded your current quota, please check your plan and billing details.",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      },
    });
    expect(normalized.category).toBe("quota_exhausted");
    expect(normalized.retryAfterMs).toBe(86_400_000);
  });

  test("unknown provider bare 429 stays quota_exhausted", () => {
    const err = {
      category: "quota_exhausted" as const,
      message: "Too Many Requests",
      statusCode: 429,
      providerId: "openai",
      retryAfterMs: 5_000,
      raw: { error: { message: "Too Many Requests" } },
    };
    expect(normalizeInferenceErrorForRetry(err)).toEqual(err);
  });

  test("known-Codex bare 429 without usage_limit_reached remaps to retryable", () => {
    const bare = {
      category: "quota_exhausted" as const,
      message: "Too Many Requests",
      statusCode: 429,
      retryAfterMs: 5_000,
      raw: { error: { message: "Too Many Requests" } },
    };

    expect(normalizeInferenceErrorForRetry(bare)).toEqual(bare);

    const viaProviderId = normalizeInferenceErrorForRetry({
      ...bare,
      providerId: "codex/abk-labs",
    });
    expect(viaProviderId.category).toBe("retryable");
    expect(viaProviderId.retryAfterMs).toBe(5_000);
    expect(viaProviderId.message.toLowerCase()).toMatch(/rate limit/);
    expect(viaProviderId.message.toLowerCase()).not.toMatch(/quota exhausted|usage limit reached/);
  });

  test("known-Codex 429 with ChatGPT usage-limit prose remaps to retryable", () => {
    const normalized = normalizeInferenceErrorForRetry({
      category: "quota_exhausted",
      message: "You have hit your ChatGPT usage limit",
      statusCode: 429,
      providerId: "codex/abk-labs",
      raw: "You have hit your ChatGPT usage limit",
    });
    expect(normalized.category).toBe("retryable");
    expect(normalized.message.toLowerCase()).toMatch(/rate limit/);
    expect(normalized.message.toLowerCase()).not.toMatch(/quota exhausted|usage limit reached/);
  });

  test("known-Codex 429 with empty body remaps to retryable", () => {
    const normalized = normalizeInferenceErrorForRetry({
      category: "quota_exhausted",
      message: "Too Many Requests",
      statusCode: 429,
      providerId: "codex/abk-labs",
    });
    expect(normalized.category).toBe("retryable");
  });

  test("known-Codex usage_limit_reached 429 stays quota_exhausted", () => {
    const normalized = normalizeInferenceErrorForRetry({
      category: "quota_exhausted",
      message: "Too Many Requests",
      statusCode: 429,
      providerId: "codex/abk-labs",
      raw: {
        detail: {
          error: {
            code: "usage_limit_reached",
            message: "You have reached your usage limit. Try again later.",
            plan_type: "workspace_member",
            resets_in_seconds: 3435,
          },
        },
      },
    });
    expect(normalized.category).toBe("quota_exhausted");
    expect(normalized.retryAfterMs).toBe(3_435_000);
    expect(normalized.message).toContain('Codex profile "abk-labs"');
  });
});
