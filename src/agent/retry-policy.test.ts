import { describe, expect, test } from "bun:test";
import { createIntercodeRetryPolicy } from "./retry-policy.js";

const HTML_503 = `<!DOCTYPE html><html><body>503 Service Unavailable Cloudflare</body></html>`;

describe("createIntercodeRetryPolicy", () => {
  test("retries protocol_mismatch when the body is an HTML 503 gateway page", async () => {
    const policy = createIntercodeRetryPolicy();
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
    const policy = createIntercodeRetryPolicy();
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
});