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
});
