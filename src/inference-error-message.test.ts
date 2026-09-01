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
  test("uses the selected provider display label in the terminal guidance", () => {
    expect(terminalProviderFailureMessage("openai", "OpenAI")).toBe(
      'OpenAI Provider failed. Try again or switch with "/model" and select another.',
    );
  });

  test("falls back to the selected provider id", () => {
    expect(terminalProviderFailureMessage("custom-provider")).toBe(
      'custom-provider Provider failed. Try again or switch with "/model" and select another.',
    );
  });

  test("does not duplicate Provider in configured display labels", () => {
    expect(terminalProviderFailureMessage("codex/work", "Codex Provider")).toBe(
      'Codex Provider failed. Try again or switch with "/model" and select another.',
    );
  });

  test("uses a safe label when the provider id contains only control sequences", () => {
    const message = terminalProviderFailureMessage("\u001b[31m\u001b[0m");
    expect(message).toBe(
      'Unknown Provider failed. Try again or switch with "/model" and select another.',
    );
    expect(message).not.toContain("\u001b");
  });
});
