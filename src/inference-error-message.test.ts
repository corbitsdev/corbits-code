import { describe, expect, test } from "bun:test";

import { inferenceErrorMessage } from "./inference-error-message.js";

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
});
