import { describe, expect, test } from "bun:test";
import { createProviderFailureAttemptTracker } from "./provider-failure-attempt.js";

describe("provider failure attempt tracker", () => {
  test("does not carry a settled attempt's diagnostic into the next attempt", () => {
    const tracker = createProviderFailureAttemptTracker();
    const first = tracker.begin();
    tracker.observe({
      providerId: "openai",
      category: "protocol_mismatch",
      message: "stale diagnostic",
    });
    tracker.settle(first);

    const second = tracker.begin();

    expect(second).toEqual({ observed: false, error: undefined });
  });

  test("settling an older attempt does not clear the active attempt", () => {
    const tracker = createProviderFailureAttemptTracker();
    const first = tracker.begin();
    const second = tracker.begin();

    tracker.settle(first);
    tracker.observe({
      providerId: "xai/work",
      category: "credential_failure",
      message: "HTTP 401",
    });

    expect(second).toEqual({
      observed: true,
      error: {
        providerId: "xai/work",
        category: "credential_failure",
        message: "HTTP 401",
      },
    });
  });
});
