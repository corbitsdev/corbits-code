import { describe, expect, test } from "bun:test";

import { caughtDebug } from "./caught.js";

// @intx/log renders the {error} template at sink level, so capture both the
// message template and the properties to pin the normalization-and-append
// contract.
describe("caughtDebug", () => {
  interface Capture {
    message: string;
    properties: Record<string, unknown> | undefined;
  }
  const capture = {
    debug: (message: string, properties?: Record<string, unknown>) => {
      capture.last = { message, properties };
    },
    last: undefined as Capture | undefined,
  };

  test("Error values feed {error} from .message", () => {
    caughtDebug(capture, "teardown failed")(new Error("boom"));
    expect(capture.last?.message).toBe("teardown failed: {error}");
    expect(capture.last?.properties).toEqual({ error: "boom" });
  });

  test("non-Error values are String()ed", () => {
    caughtDebug(capture, "teardown failed")("boom-string");
    expect(capture.last?.properties).toEqual({ error: "boom-string" });
  });

  test("a sanitizer runs on the normalized error message", () => {
    caughtDebug(capture, "teardown failed", (error) =>
      error.replaceAll("secret", "[redacted]"),
    )(new Error("secret leaked"));
    expect(capture.last?.properties).toEqual({
      error: "[redacted] leaked",
    });
  });
});
