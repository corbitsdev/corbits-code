import { describe, test, expect } from "bun:test"

import { quotaWaitSeconds, shouldAutoRetryQuota } from "./quota-retry.js"

describe("shouldAutoRetryQuota", () => {
  const base = {
    quotaError: { retryAt: 1_000 },
    alreadyFired: false,
    nowMs: 2_000,
    lastSentMessage: "run the build",
  }

  test("retries once the window has elapsed and a prompt is pending", () => {
    expect(shouldAutoRetryQuota(base)).toBe(true)
  })

  test("does not retry before the retry-after window", () => {
    expect(shouldAutoRetryQuota({ ...base, nowMs: 500 })).toBe(false)
  })

  test("does not retry when there is no quota error", () => {
    expect(shouldAutoRetryQuota({ ...base, quotaError: null })).toBe(false)
  })

  test("does not retry when the guard has already fired", () => {
    expect(shouldAutoRetryQuota({ ...base, alreadyFired: true })).toBe(false)
  })

  // Regression guard: an interrupt clears the last-sent prompt so a
  // stopped turn is never silently replayed by the quota auto-retry loop.
  test("does not replay a cleared last-sent message after an interrupt", () => {
    expect(shouldAutoRetryQuota({ ...base, lastSentMessage: "" })).toBe(false)
    expect(shouldAutoRetryQuota({ ...base, lastSentMessage: "   " })).toBe(false)
  })
})

describe("quotaWaitSeconds", () => {
  test("rounds up and never goes negative", () => {
    expect(quotaWaitSeconds(10_500, 8_000)).toBe(3)
    expect(quotaWaitSeconds(1_000, 9_000)).toBe(0)
  })
})
