import { describe, expect, test } from "bun:test";

import {
  inferenceErrorMessage,
  terminalProviderFailureMessage,
} from "./inference-error-message.js";

const CODEX_BODY = {
  detail: {
    error: {
      code: "usage_limit_reached",
      message: "You have reached your usage limit.",
      plan_type: "workspace_member",
      resets_in_seconds: 3435,
    },
  },
};

describe("inferenceErrorMessage", () => {
  test("surfaces Codex usage_limit_reached with reset ETA", () => {
    const line = inferenceErrorMessage({
      category: "quota_exhausted",
      message: "Too Many Requests",
      statusCode: 429,
      raw: CODEX_BODY,
    });
    expect(line).toContain("Codex usage limit reached");
    expect(line).toMatch(/Resets in ~/);
    expect(line).toContain("/model");
  });

  test("does not brand a known non-Codex provider as Codex", () => {
    const line = inferenceErrorMessage({
      category: "quota_exhausted",
      message: "Too Many Requests",
      statusCode: 429,
      providerId: "openai",
      raw: CODEX_BODY,
    });
    expect(line).not.toContain("Codex");
    expect(line).toBe("Quota exhausted — usage limit reached.");
  });

  test("known-xAI short 429 shows rate-limit line, not Quota exhausted", () => {
    const line = inferenceErrorMessage({
      category: "quota_exhausted",
      message: "Too Many Requests",
      statusCode: 429,
      providerId: "xai/thegreataxios",
      raw: { error: { message: "Too Many Requests" } },
    });
    expect(line.toLowerCase()).toMatch(/rate limit/);
    expect(line).not.toContain("Quota exhausted");
  });

  test("known-xAI quota body still shows Quota exhausted", () => {
    const line = inferenceErrorMessage({
      category: "quota_exhausted",
      message: "You exceeded your current quota",
      statusCode: 429,
      providerId: "xai/thegreataxios",
      raw: {
        error: {
          message: "You exceeded your current quota",
          code: "insufficient_quota",
        },
      },
    });
    expect(line).toBe("Quota exhausted — usage limit reached.");
  });

  test("known-Codex short 429 shows rate-limit line, not usage-limit copy", () => {
    const line = inferenceErrorMessage({
      category: "quota_exhausted",
      message: "You have hit your ChatGPT usage limit",
      statusCode: 429,
      providerId: "codex/abk-labs",
      raw: "You have hit your ChatGPT usage limit",
    });
    expect(line.toLowerCase()).toMatch(/rate limit/);
    expect(line).not.toContain("Quota exhausted");
    expect(line.toLowerCase()).not.toContain("the usage limit has been reached");
    expect(line.toLowerCase()).not.toContain("usage limit reached");
  });

  test("credential_failure tells the user to log in again", () => {
    const line = inferenceErrorMessage({
      category: "credential_failure",
      message: '{"error":{"code":401}}',
    });
    expect(line.toLowerCase()).not.toContain("re-authenticating");
    expect(line.toLowerCase()).toMatch(/log in again|sign in again/);
  });
});

describe("terminalProviderFailureMessage", () => {
  test("surfaces a retryable HTTP failure with safe retry guidance", () => {
    expect(
      terminalProviderFailureMessage(
        "openai",
        {
          category: "retryable",
          message: "\u001b[31mupstream\n unavailable\u001b[0m",
          statusCode: 500,
        },
        "OpenAI",
      ),
    ).toBe("OpenAI Provider failed (retryable): upstream unavailable. Try again.");
  });

  test("surfaces protocol mismatches with switch-model guidance", () => {
    expect(
      terminalProviderFailureMessage("custom-provider", {
        category: "protocol_mismatch",
        message: "response did not match the expected schema",
      }),
    ).toBe(
      'custom-provider Provider failed (protocol_mismatch): response did not match the expected schema. Switch models with "/model".',
    );
  });

  test("treats an HTTP 503 protocol mismatch as transient", () => {
    expect(
      terminalProviderFailureMessage("custom-provider", {
        category: "protocol_mismatch",
        message: "gateway returned HTML",
        statusCode: 503,
      }),
    ).toBe(
      "custom-provider Provider failed (protocol_mismatch): gateway returned HTML. Try again.",
    );
  });

  test("uses the canonical category for a misclassified context overflow", () => {
    expect(
      terminalProviderFailureMessage("custom-provider", {
        category: "retryable",
        message: "input exceeds the maximum context window",
        statusCode: 429,
      }),
    ).toBe(
      "custom-provider Provider failed (context_overflow): input exceeds the maximum context window. Try /clear to start fresh.",
    );
  });

  test("tells the user to log in again after a credential failure", () => {
    expect(
      terminalProviderFailureMessage("custom-provider", {
        category: "credential_failure",
        message: "HTTP 401 Unauthorized",
        statusCode: 401,
      }),
    ).toBe(
      "custom-provider Provider failed (credential_failure): HTTP 401 Unauthorized. Authentication failed — log in again.",
    );
  });

  test.each([
    {
      name: "Bearer header",
      secret: "bearer-secret-token-1234567890",
      diagnostic: "Authorization: Bearer bearer-secret-token-1234567890",
    },
    {
      name: "Basic authorization header",
      secret: "dXNlcjpwYXNzd29yZA==",
      diagnostic: "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    },
    {
      name: "api_key query parameter",
      secret: "query-secret-value",
      diagnostic: "GET https://provider.invalid/v1?api_key=query-secret-value&model=test",
    },
    {
      name: "JSON credential fields",
      secret: "json-secret-value",
      diagnostic:
        '{"api_key":"json-secret-value","password":"json-secret-value","authorization":"json-secret-value"}',
    },
  ])("scrubs $name before display", ({ secret, diagnostic }) => {
    const message = terminalProviderFailureMessage("custom-provider", {
      category: "fatal",
      message: diagnostic,
    });

    expect(message).toContain("[redacted: looks like a credential]");
    expect(message).not.toContain(secret);
  });

  test("scrubs a Bearer token split by ANSI controls", () => {
    const secret = "bearer-secret-token-1234567890";
    const message = terminalProviderFailureMessage("custom-provider", {
      category: "fatal",
      message: "Authorization: Bearer bearer-secret-\u001b[31mtoken-1234567890\u001b[0m",
    });

    expect(message).toContain("[redacted: looks like a credential]");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("\u001b");
  });

  test("does not duplicate Provider in configured display labels", () => {
    expect(
      terminalProviderFailureMessage(
        "codex/work",
        { category: "fatal", message: "service rejected the request" },
        "Codex Provider",
      ),
    ).toBe(
      'Codex Provider failed (fatal): service rejected the request. Try again or switch models with "/model".',
    );
  });

  test("uses a safe label when the provider id contains only control sequences", () => {
    const message = terminalProviderFailureMessage("\u001b[31m\u001b[0m", {
      category: "fatal",
      message: "request failed",
    });
    expect(message).toBe(
      'Unknown Provider failed (fatal): request failed. Try again or switch models with "/model".',
    );
    expect(message).not.toContain("\u001b");
  });

  test("bounds provider-controlled display text", () => {
    const message = terminalProviderFailureMessage("custom-provider", {
      category: "fatal",
      message: "x".repeat(1_000),
    });

    expect(message).toContain(`${"x".repeat(239)}…`);
    expect(message).not.toContain("x".repeat(241));
  });
});
