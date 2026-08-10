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
});
