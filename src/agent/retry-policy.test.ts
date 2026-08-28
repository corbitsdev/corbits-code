import { describe, expect, test } from "bun:test";
import { createCorbitsRetryPolicy } from "./retry-policy.js";

const HTML_503 = `<!DOCTYPE html><html><body>503 Service Unavailable Cloudflare</body></html>`;

describe("createCorbitsRetryPolicy", () => {
  test("retries protocol_mismatch when the body is an HTML 503 gateway page", async () => {
    const policy = createCorbitsRetryPolicy();
    const decision = await policy({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "protocol_mismatch",
        message: "malformed JSON in SSE data payload",
        raw: HTML_503,
      },
    });
    expect(decision).toEqual({ kind: "retry", delayMs: 500 });
  });

  test("aborts long-window quota exhaustion", async () => {
    const policy = createCorbitsRetryPolicy();
    const decision = await policy({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted",
        message: "monthly cap",
        retryAfterMs: 86_400_000,
      },
    });
    expect(decision).toEqual({ kind: "abort" });
  });

  test("aborts Codex usage_limit_reached when resets_in_seconds is a long window", async () => {
    const policy = createCorbitsRetryPolicy();
    const decision = await policy({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted",
        message: "Too Many Requests",
        statusCode: 429,
        raw: {
          detail: {
            error: {
              code: "usage_limit_reached",
              message: "You have reached your usage limit.",
              plan_type: "workspace_member",
              resets_in_seconds: 3435,
            },
          },
        },
      },
    });
    expect(decision).toEqual({ kind: "abort" });
  });

  test("stamped xAI bare 429 retries as retryable, not long-quota abort", async () => {
    const policy = createCorbitsRetryPolicy({ providerId: "xai/thegreataxios" });
    const decision = await policy({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted",
        message: "Too Many Requests",
        statusCode: 429,
        retryAfterMs: 45_000,
        raw: { error: { message: "Too Many Requests" } },
      },
    });
    // Remapped to retryable -> default backoff, not abort on moderate Retry-After.
    expect(decision).toEqual({ kind: "retry", delayMs: 500 });
  });

  test("stamped Codex bare 429 retries as retryable, not long-quota abort", async () => {
    const policy = createCorbitsRetryPolicy({ providerId: "codex/abk-labs" });
    const decision = await policy({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted",
        message: "You have hit your ChatGPT usage limit",
        statusCode: 429,
        retryAfterMs: 45_000,
        raw: "You have hit your ChatGPT usage limit",
      },
    });
    expect(decision).toEqual({ kind: "retry", delayMs: 500 });
  });

  test("stamped xAI usage/quota body still aborts on long retryAfterMs", async () => {
    const policy = createCorbitsRetryPolicy({ providerId: "xai/thegreataxios" });
    const decision = await policy({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted",
        message: "You exceeded your current quota",
        statusCode: 429,
        retryAfterMs: 86_400_000,
        raw: {
          error: {
            message: "You exceeded your current quota",
            code: "insufficient_quota",
          },
        },
      },
    });
    expect(decision).toEqual({ kind: "abort" });
  });

  test("unknown provider bare 429 with moderate Retry-After still aborts as quota", async () => {
    const policy = createCorbitsRetryPolicy({ providerId: "openai" });
    const decision = await policy({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted",
        message: "Too Many Requests",
        statusCode: 429,
        retryAfterMs: 45_000,
        raw: { error: { message: "Too Many Requests" } },
      },
    });
    expect(decision).toEqual({ kind: "abort" });
  });

  test("live providerId getter: non-xAI → xAI starts remapping bare 429", async () => {
    let current: string | undefined = "openai";
    const policy = createCorbitsRetryPolicy({ providerId: () => current });
    const bare429 = {
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted" as const,
        message: "Too Many Requests",
        statusCode: 429,
        retryAfterMs: 45_000,
        raw: { error: { message: "Too Many Requests" } },
      },
    };
    expect(await policy(bare429)).toEqual({ kind: "abort" });
    current = "xai/thegreataxios";
    expect(await policy(bare429)).toEqual({ kind: "retry", delayMs: 500 });
  });

  // CL-6910: the harness only surfaces `inference.error` to the director
  // once this policy returns `abort` — so the attempt cap here IS the
  // on-wire send cap for these categories (the director no longer re-wraps
  // them, see director.test.ts). Bound at 3 sends for each error class the
  // ticket names: rate limit (quota_exhausted), gateway error and malformed
  // response (both normalized to retryable/protocol_mismatch here).
  test("rate limit (quota_exhausted) aborts by the 3rd attempt — bounds harness sends to 3", async () => {
    const policy = createCorbitsRetryPolicy();
    const situation = (attempt: number) => ({
      attempt,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted" as const,
        message: "Too Many Requests",
        statusCode: 429,
        retryAfterMs: 10,
      },
    });
    expect(await policy(situation(1))).toEqual({ kind: "retry", delayMs: 10 });
    expect(await policy(situation(2))).toEqual({ kind: "retry", delayMs: 10 });
    expect(await policy(situation(3))).toEqual({ kind: "abort" });
  });

  test("gateway error (retryable) aborts by the 3rd attempt — bounds harness sends to 3", async () => {
    const policy = createCorbitsRetryPolicy();
    const situation = (attempt: number) => ({
      attempt,
      elapsedMs: 0,
      error: { category: "retryable" as const, message: "gateway timeout" },
    });
    expect(await policy(situation(1))).toEqual({ kind: "retry", delayMs: 500 });
    expect(await policy(situation(2))).toEqual({ kind: "retry", delayMs: 1000 });
    expect(await policy(situation(3))).toEqual({ kind: "abort" });
  });

  test("malformed response (HTML gateway page) aborts by the 3rd attempt — bounds harness sends to 3", async () => {
    const policy = createCorbitsRetryPolicy();
    const situation = (attempt: number) => ({
      attempt,
      elapsedMs: 0,
      error: {
        category: "protocol_mismatch" as const,
        message: "malformed JSON in SSE data payload",
        raw: HTML_503,
      },
    });
    expect(await policy(situation(1))).toEqual({ kind: "retry", delayMs: 500 });
    expect(await policy(situation(2))).toEqual({ kind: "retry", delayMs: 1000 });
    expect(await policy(situation(3))).toEqual({ kind: "abort" });
  });

  test("live providerId getter: xAI → non-xAI stops remapping bare 429", async () => {
    let current: string | undefined = "xai/thegreataxios";
    const policy = createCorbitsRetryPolicy({ providerId: () => current });
    const bare429 = {
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted" as const,
        message: "Too Many Requests",
        statusCode: 429,
        retryAfterMs: 45_000,
        raw: { error: { message: "Too Many Requests" } },
      },
    };
    expect(await policy(bare429)).toEqual({ kind: "retry", delayMs: 500 });
    current = "openai";
    expect(await policy(bare429)).toEqual({ kind: "abort" });
  });
});
