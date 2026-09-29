import { describe, expect, test } from "bun:test";
import {
  carriesCodexReLoginHint,
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
        message:
          "openai parseResponse: malformed JSON in SSE data payload: Unexpected token '<'",
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
        error: {
          type: "GoUsageLimitError",
          message: "subscription quota exceeded",
        },
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
          message:
            "Error from provider (Console Go): Provider rate limit exceeded",
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

  // intx defaults 429 → quota_exhausted; known-provider context channels
  // reclassify a bare 429 (no quota markers in the body) as a plain rate
  // limit. A reclassified message must never claim quota/usage-limit copy.
  const BARE_429 = {
    category: "quota_exhausted" as const,
    message: "Too Many Requests",
    statusCode: 429,
    retryAfterMs: 45_000,
    raw: { error: { message: "Too Many Requests" } },
  };

  // Live Codex usage-limit 429 body: plan metadata plus a reset ETA the
  // normalizer converts to retryAfterMs.
  const CODEX_USAGE_LIMIT_BODY = {
    detail: {
      error: {
        code: "usage_limit_reached",
        message: "You have reached your usage limit. Try again later.",
        plan_type: "workspace_member",
        resets_in_seconds: 3435,
      },
    },
  };

  test.each([
    { requestURL: "https://opencode.ai/zen/go/v1/chat/completions" },
    { providerId: "opencode-go" },
    { opencodeGo: true },
    { providerId: "xai/thegreataxios" },
    { providerId: "codex/abk-labs" },
  ])("known-provider bare 429 reclassifies as retryable (%j)", (context) => {
    const normalized = normalizeInferenceErrorForRetry({
      ...BARE_429,
      ...context,
    });
    expect(normalized.category).toBe("retryable");
    expect(normalized.retryAfterMs).toBe(45_000);
    expect(normalized.message.toLowerCase()).toMatch(
      /too many requests|rate limit/,
    );
    expect(normalized.message.toLowerCase()).not.toMatch(
      /quota exhausted|usage limit reached/,
    );
  });

  test.each([{}, { providerId: "openai" }])(
    "bare 429 without a known provider keeps intx's quota_exhausted (%j)",
    (context) => {
      const err = { ...BARE_429, ...context };
      expect(normalizeInferenceErrorForRetry(err)).toEqual(err);
    },
  );

  test("403 with usage-limit body reclassifies as quota_exhausted", () => {
    const normalized = normalizeInferenceErrorForRetry({
      category: "credential_failure",
      message: "forbidden",
      statusCode: 403,
      raw: {
        type: "error",
        error: {
          type: "GoUsageLimitError",
          message: "subscription usage limit reached",
        },
      },
    });
    expect(normalized.category).toBe("quota_exhausted");
    expect(normalized.message.toLowerCase()).toMatch(/usage limit|quota/);
  });

  test("maps Codex usage_limit_reached detail.error body to quota_exhausted with reset ETA", () => {
    const normalized = normalizeInferenceErrorForRetry({
      category: "quota_exhausted",
      message: "Too Many Requests",
      statusCode: 429,
      raw: CODEX_USAGE_LIMIT_BODY,
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
    expect(normalized.message.startsWith("Codex usage limit reached")).toBe(
      true,
    );
    expect(normalized.message).toContain("~2m");
  });

  test("does not rebrand OpenAI insufficient_quota as Codex", () => {
    const error = {
      category: "quota_exhausted" as const,
      message:
        "You exceeded your current quota, please check your plan and billing details.",
      statusCode: 429,
      raw: {
        error: {
          message:
            "You exceeded your current quota, please check your plan and billing details.",
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

  /**
   * Wire shape for a revoked Codex credential: the harness classifies the
   * HTTP 404 as fatal with the statusText message while the JSON body rides
   * on raw. The body carries the auth-rejection signal; the status line
   * alone ("Not Found") must never reclassify.
   */
  const REVOKED_CREDENTIAL_404_RAW = {
    error: {
      code: "invalid_token",
      message: "Not authorized: the access token has been revoked",
      type: "invalid_request_error",
    },
  };

  test("Codex 404 with a revoked-credential body reclassifies as credential_failure", () => {
    const normalized = normalizeInferenceErrorForRetry({
      category: "fatal",
      message: "Not Found",
      statusCode: 404,
      providerId: "codex/work",
      raw: REVOKED_CREDENTIAL_404_RAW,
    });
    expect(normalized.category).toBe("credential_failure");
    expect(normalized.message).toContain('Codex profile "work"');
    expect(carriesCodexReLoginHint(normalized.message)).toBe(true);
    // Original diagnostic rides along so the failure stays debuggable, and
    // the wire body stays on raw for logs.
    expect(normalized.message).toContain("Not Found");
    expect(normalized.raw).toEqual(REVOKED_CREDENTIAL_404_RAW);
  });

  test.each([
    { name: "not authorized", body: "Not authorized" },
    { name: "unauthorized", body: "401 Unauthorized" },
    { name: "invalid token", body: "Invalid token" },
    { name: "expired", body: "The access token expired" },
    { name: "revoked", body: "Token has been revoked" },
  ])("Codex 404 with $name signal reclassifies", ({ body }) => {
    const normalized = normalizeInferenceErrorForRetry({
      category: "fatal",
      message: "Not Found",
      statusCode: 404,
      providerId: "codex/work",
      raw: { error: { message: body } },
    });
    expect(normalized.category).toBe("credential_failure");
    expect(carriesCodexReLoginHint(normalized.message)).toBe(true);
  });

  test("Codex 404 with an auth signal in the message reclassifies", () => {
    const normalized = normalizeInferenceErrorForRetry({
      category: "fatal",
      message: "Invalid token: expired",
      statusCode: 404,
      providerId: "codex/work",
    });
    expect(normalized.category).toBe("credential_failure");
    expect(normalized.message).toContain("Invalid token: expired");
  });

  test.each([
    {
      name: "bare 404 without an auth signal",
      error: {
        category: "fatal" as const,
        message: "Not Found",
        statusCode: 404,
        providerId: "codex/work",
      },
    },
    {
      name: "routing 404 without an auth signal",
      error: {
        category: "fatal" as const,
        message: "Not Found",
        statusCode: 404,
        providerId: "codex/work",
        raw: { error: { code: "not_found", message: "No such endpoint" } },
      },
    },
    {
      name: "404 naming a dotted unknown model",
      error: {
        category: "fatal" as const,
        message: "The model 'gpt-3.5-turbo' does not exist",
        statusCode: 404,
        providerId: "codex/work",
      },
    },
    {
      name: "404 naming an unknown model keeps fatal switch-models guidance",
      error: {
        category: "fatal" as const,
        message: "The model 'gpt-99' does not exist",
        statusCode: 404,
        providerId: "codex/work",
        raw: {
          error: {
            code: "model_not_found",
            message: "The model 'gpt-99' does not exist",
            type: "invalid_request_error",
          },
        },
      },
    },
  ])("Codex $name stays fatal", ({ error }) => {
    expect(normalizeInferenceErrorForRetry(error)).toBe(error);
  });

  test("Codex model-deprecation 404 containing 'expired' stays fatal", () => {
    // Keeper: a retired model names itself with the credential marker word,
    // but logging in again cannot resurrect it — the fatal switch-models
    // path must win over the expired-credential reclassification.
    const error = {
      category: "fatal" as const,
      message:
        "The model 'gpt-4o' has expired. Migrate to 'gpt-5' to continue.",
      statusCode: 404,
      providerId: "codex/work",
      raw: {
        error: {
          code: "model_expired",
          message: "The model 'gpt-4o' has expired (2025-02-01).",
          type: "invalid_request_error",
        },
      },
    };
    expect(normalizeInferenceErrorForRetry(error)).toBe(error);
  });

  test("non-Codex 404 keeps fatal switch-models guidance", () => {
    const error = {
      category: "fatal" as const,
      message: "Not Found",
      statusCode: 404,
      providerId: "custom-provider",
    };
    expect(normalizeInferenceErrorForRetry(error)).toBe(error);
  });

  test("non-Codex 404 with an auth signal keeps provider scoping", () => {
    const error = {
      category: "fatal" as const,
      message: "Not Found",
      statusCode: 404,
      providerId: "custom-provider",
      raw: { error: { message: "Token has been revoked" } },
    };
    expect(normalizeInferenceErrorForRetry(error)).toBe(error);
  });

  test.each([
    {
      name: "message-only capacity protocol error",
      error: {
        category: "protocol_mismatch" as const,
        message: "The model is currently at capacity. Please try again later.",
        providerId: "xai/default",
        retryAfterMs: 2_500,
      },
      retryAfterMs: 2_500,
    },
    {
      name: "JSON-bodied high-demand protocol error",
      error: {
        category: "protocol_mismatch" as const,
        message: "malformed JSON in SSE data payload",
        providerId: "xai/default",
        raw: {
          error: {
            message: "The service is unavailable due to high demand",
          },
        },
      },
      retryAfterMs: undefined,
    },
    {
      name: "exact temporary-unavailable phrase",
      error: {
        category: "protocol_mismatch" as const,
        message: "Service temporarily unavailable",
        providerId: "xai/default",
      },
      retryAfterMs: undefined,
    },
    {
      name: "exact phrase carried on raw",
      error: {
        category: "protocol_mismatch" as const,
        message: "malformed JSON in SSE data payload",
        providerId: "xai/default",
        raw: "Service temporarily unavailable",
      },
      retryAfterMs: undefined,
    },
    {
      name: "exact phrase nested in JSON raw",
      error: {
        category: "protocol_mismatch" as const,
        message: "malformed JSON in SSE data payload",
        providerId: "xai/default",
        raw: { error: { message: "Service temporarily unavailable" } },
      },
      retryAfterMs: undefined,
    },
  ])("known-xAI $name becomes retryable", ({ error, retryAfterMs }) => {
    const normalized = normalizeInferenceErrorForRetry(error);
    expect(normalized.category).toBe("retryable");
    if (retryAfterMs !== undefined) {
      expect(normalized.retryAfterMs).toBe(retryAfterMs);
    }
  });

  test("mixed xAI capacity and quota copy stays unchanged", () => {
    const error = {
      category: "protocol_mismatch" as const,
      message: "The model is currently at capacity: quota exceeded",
      providerId: "xai/default",
    };
    expect(normalizeInferenceErrorForRetry(error)).toBe(error);
  });

  test("explicit Grok adapter overload protocol error becomes retryable", () => {
    const normalized = normalizeInferenceErrorForRetry({
      category: "protocol_mismatch",
      message: "The upstream service is overloaded",
      providerId: "grok-responses",
    });
    expect(normalized.category).toBe("retryable");
  });

  test("unknown provider capacity protocol_mismatch stays unchanged", () => {
    const error = {
      category: "protocol_mismatch" as const,
      message: "The model is currently at capacity",
      providerId: "openai",
    };
    expect(normalizeInferenceErrorForRetry(error)).toBe(error);
  });

  test("OpenCode Go capacity prose stays protocol_mismatch", () => {
    const error = {
      category: "protocol_mismatch" as const,
      message: "The model is currently at capacity",
      providerId: "opencode-go/default",
    };
    expect(normalizeInferenceErrorForRetry(error)).toBe(error);
  });

  test("known-xAI quota exhaustion stays non-retryable despite capacity prose", () => {
    const error = {
      category: "quota_exhausted" as const,
      message: "Service temporarily unavailable: quota exhausted",
      statusCode: 429,
      providerId: "xai/default",
      retryAfterMs: 86_400_000,
    };
    expect(normalizeInferenceErrorForRetry(error)).toBe(error);
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
          message:
            "You exceeded your current quota, please check your plan and billing details.",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      },
    });
    expect(normalized.category).toBe("quota_exhausted");
    expect(normalized.retryAfterMs).toBe(86_400_000);
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
    expect(normalized.message.toLowerCase()).not.toMatch(
      /quota exhausted|usage limit reached/,
    );
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
      raw: CODEX_USAGE_LIMIT_BODY,
    });
    expect(normalized.category).toBe("quota_exhausted");
    expect(normalized.retryAfterMs).toBe(3_435_000);
    expect(normalized.message).toContain('Codex profile "abk-labs"');
  });
});
