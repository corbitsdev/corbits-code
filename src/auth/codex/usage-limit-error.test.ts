import { describe, expect, test } from "bun:test";
import {
  codexUsageLimitRetryAfterMs,
  formatCodexUsageLimitMessage,
  formatResetETA,
  parseCodexUsageLimitError,
} from "./usage-limit-error.js";

/** Live body captured from chatgpt.com/backend-api/codex/responses. */
const LIVE_USAGE_LIMIT_BODY = {
  detail: {
    error: {
      code: "usage_limit_reached",
      message: "You have reached your usage limit. Try again later.",
      plan_type: "workspace_member",
      resets_in_seconds: 3435,
    },
  },
};

describe("parseCodexUsageLimitError", () => {
  test("parses the live nested detail.error body", () => {
    const parsed = parseCodexUsageLimitError(LIVE_USAGE_LIMIT_BODY);
    expect(parsed).toEqual({
      code: "usage_limit_reached",
      message: "You have reached your usage limit. Try again later.",
      planType: "workspace_member",
      resetsInSeconds: 3435,
    });
  });

  test("parses a JSON string of the same shape", () => {
    const parsed = parseCodexUsageLimitError(JSON.stringify(LIVE_USAGE_LIMIT_BODY));
    expect(parsed?.code).toBe("usage_limit_reached");
    expect(parsed?.resetsInSeconds).toBe(3435);
  });

  test("parses a top-level error object", () => {
    const parsed = parseCodexUsageLimitError({
      error: {
        code: "usage_limit_reached",
        message: "limit",
        plan_type: "plus",
        resets_in_seconds: 90,
      },
    });
    expect(parsed).toEqual({
      code: "usage_limit_reached",
      message: "limit",
      planType: "plus",
      resetsInSeconds: 90,
    });
  });

  test("returns undefined for unrelated 429 bodies", () => {
    expect(
      parseCodexUsageLimitError({
        error: { message: "Too Many Requests", code: "rate_limit_exceeded" },
      }),
    ).toBeUndefined();
    expect(parseCodexUsageLimitError({ ok: true })).toBeUndefined();
    expect(parseCodexUsageLimitError(undefined)).toBeUndefined();
  });

  test("does not claim OpenAI insufficient_quota as Codex", () => {
    expect(
      parseCodexUsageLimitError({
        error: {
          message: "You exceeded your current quota, please check your plan and billing details.",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      }),
    ).toBeUndefined();
  });

  test("does not claim OpenAI rate_limit_exceeded copy as Codex", () => {
    expect(
      parseCodexUsageLimitError({
        error: {
          message: "Rate limit reached for gpt-4 in organization org-x on tokens per min",
          type: "tokens",
          code: "rate_limit_exceeded",
        },
      }),
    ).toBeUndefined();
  });

  test("does not match message-only 'limit reached' without a Codex code", () => {
    expect(
      parseCodexUsageLimitError({
        error: { message: "You have reached your usage limit." },
      }),
    ).toBeUndefined();
  });
});

describe("formatCodexUsageLimitMessage", () => {
  test("names plan, reset ETA, and profile switch path", () => {
    const parsed = parseCodexUsageLimitError(LIVE_USAGE_LIMIT_BODY);
    expect(parsed).toBeDefined();
    const line = formatCodexUsageLimitMessage(parsed!, { profile: "abk-labs" });
    expect(line).toContain('Codex profile "abk-labs"');
    expect(line).toContain("workspace member");
    expect(line).toMatch(/Resets in ~/);
    expect(line).toContain("/model");
  });

  test("works without a profile name", () => {
    const line = formatCodexUsageLimitMessage({
      code: "usage_limit_reached",
      message: "limit",
      planType: "plus",
      resetsInSeconds: 120,
    });
    expect(line.startsWith("Codex usage limit reached")).toBe(true);
    expect(line).toContain("plus");
    expect(line).toContain("~2m");
  });
});

describe("codexUsageLimitRetryAfterMs / formatResetETA", () => {
  test("converts seconds to ms", () => {
    expect(
      codexUsageLimitRetryAfterMs({
        code: "usage_limit_reached",
        message: "",
        resetsInSeconds: 3435,
      }),
    ).toBe(3_435_000);
    expect(
      codexUsageLimitRetryAfterMs({ code: "usage_limit_reached", message: "" }),
    ).toBeUndefined();
  });

  test("formats human ETAs", () => {
    expect(formatResetETA(0)).toBe("now");
    expect(formatResetETA(45)).toBe("45s");
    expect(formatResetETA(120)).toBe("~2m");
    expect(formatResetETA(3435)).toBe("~58m");
  });
});
