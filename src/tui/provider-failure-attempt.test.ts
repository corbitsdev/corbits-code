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

    expect(second).toEqual({ observed: false, presented: false, error: undefined });
  });

  test("a settled send remains current until its terminal stream event is consumed", () => {
    const tracker = createProviderFailureAttemptTracker();
    const first = tracker.begin();
    tracker.sendSettled(first);
    const second = tracker.begin();

    tracker.observe({
      providerId: "xai/work",
      category: "credential_failure",
      message: "HTTP 401",
    });
    const reply = tracker.consumeConnectorReply();

    expect(reply).toEqual({ attempt: first, suppressPresentation: false });
    expect(first).toEqual({
      observed: true,
      presented: true,
      error: {
        providerId: "xai/work",
        category: "credential_failure",
        message: "HTTP 401",
      },
    });
    expect(second).toEqual({ observed: false, presented: false, error: undefined });
    expect(tracker.current()).toBe(first);
    tracker.consumeTerminal();
    expect(tracker.current()).toBe(second);
  });

  test("a rejected-send fallback advances when the next message starts and suppresses a late reply", () => {
    const tracker = createProviderFailureAttemptTracker();
    const first = tracker.begin();
    tracker.markPresented(first);
    tracker.sendSettled(first);
    const second = tracker.begin();

    tracker.advanceToNextMessage();
    expect(tracker.current()).toBe(second);

    tracker.observe({
      providerId: "openai",
      category: "fatal",
      message: "second failure",
    });
    tracker.markPresented(second);

    expect(tracker.consumeConnectorReply()).toEqual({
      attempt: second,
      suppressPresentation: true,
    });
  });
});
