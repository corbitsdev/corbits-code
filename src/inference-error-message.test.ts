import { describe, expect, test } from "bun:test";

import { normalizeInferenceErrorForTerminal } from "./inference-gateway-error.js";
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
    expect(line.toLowerCase()).not.toContain(
      "the usage limit has been reached",
    );
    expect(line.toLowerCase()).not.toContain("usage limit reached");
  });

  test("credential_failure tells the user to run /connect", () => {
    const line = inferenceErrorMessage({
      category: "credential_failure",
      message: '{"error":{"code":401}}',
    });
    expect(line).toContain("/connect");
    expect(line.toLowerCase()).not.toMatch(/log in again|sign in again/);
  });
});

describe("terminalProviderFailureMessage", () => {
  test("preserves full sanitized recovery URLs without a user-facing clamp", () => {
    const recoveryURL = `https://auth.example/connect?state=${"s".repeat(260)}&profile=work`;
    const message = terminalProviderFailureMessage("codex/work", {
      category: "credential_failure",
      message: `Reconnect with ${recoveryURL}; Authorization: Bearer secret-token-1234567890`,
    });

    expect(message).toContain(recoveryURL);
    expect(message).not.toContain("secret-token-1234567890");
  });

  test("terminal Codex credential 404 names the profile with a re-login hint", () => {
    const normalized = normalizeInferenceErrorForTerminal(
      {
        category: "fatal",
        message: "Not Found",
        statusCode: 404,
        raw: {
          error: {
            code: "invalid_token",
            message: "Not authorized: the access token has been revoked",
          },
        },
      },
      "codex/work",
    );
    const message = terminalProviderFailureMessage("codex/work", normalized);
    expect(message).toContain('Codex profile "work"');
    expect(message).toContain("Not Found");
    expect(message).not.toContain("/model");
    expect(message).toContain("/connect");
    expect(message).toContain("Codex");
    expect(message).not.toMatch(/log in again|sign in again/i);
  });

  test("terminal bare Codex 404 without an auth signal keeps switch-models guidance", () => {
    const normalized = normalizeInferenceErrorForTerminal(
      { category: "fatal", message: "Not Found", statusCode: 404 },
      "codex/work",
    );
    const message = terminalProviderFailureMessage("codex/work", normalized);
    expect(message).toContain('"/model"');
    expect(message.toLowerCase()).not.toMatch(/log in again/);
  });

  test("terminal genuine unknown-model 404 keeps switch-models guidance", () => {
    const message = terminalProviderFailureMessage("codex/work", {
      category: "fatal",
      message: "The model 'gpt-99' does not exist",
      statusCode: 404,
      providerId: "codex/work",
    });
    expect(message).toContain('"/model"');
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
      diagnostic:
        "GET https://provider.invalid/v1?api_key=query-secret-value&model=test",
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
      message:
        "Authorization: Bearer bearer-secret-\u001b[31mtoken-1234567890\u001b[0m",
    });

    expect(message).toContain("[redacted: looks like a credential]");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("\u001b");
  });

  test("terminal Codex short-429 failure does not claim to still be retrying", () => {
    const normalized = normalizeInferenceErrorForTerminal(
      {
        category: "quota_exhausted",
        message: "Too Many Requests",
        statusCode: 429,
      },
      "codex/default",
    );
    const message = terminalProviderFailureMessage("codex/default", normalized);
    expect(message.toLowerCase()).toMatch(/rate limit/);
    expect(message.toLowerCase()).not.toContain("retrying");
  });

  test("retryable 429 guidance asks the operator to wait before trying again", () => {
    const message = terminalProviderFailureMessage("codex/default", {
      category: "retryable",
      message: "Rate limited",
      statusCode: 429,
    });
    expect(message).toContain("Wait a moment and try again.");
  });

  test("uses a safe label when the provider id contains only control sequences", () => {
    const message = terminalProviderFailureMessage("\u001b[31m\u001b[0m", {
      category: "fatal",
      message: "request failed",
    });
    expect(message).not.toContain("\u001b");
  });

  test("preserves full provider diagnostics", () => {
    const diagnostic = "x".repeat(1_000);
    const message = terminalProviderFailureMessage("custom-provider", {
      category: "fatal",
      message: diagnostic,
    });

    expect(message).toContain(diagnostic);
    expect(message).not.toContain("…");
  });
});
