import { describe, test, expect } from "bun:test";
import { formatElapsed, resolveLabel } from "./in-flight-indicator.js";

describe("resolveLabel", () => {
  test("defaults to Thinking… when no label provided", () => {
    expect(resolveLabel(undefined)).toBe("Thinking…");
  });

  test("uses provided label when given", () => {
    expect(resolveLabel("Running tool: test")).toBe("Running tool: test");
    expect(resolveLabel("Waiting for model")).toBe("Waiting for model");
  });

  test("returns empty string when explicitly set", () => {
    expect(resolveLabel("")).toBe("");
  });
});

describe("formatElapsed", () => {
  test("uses seconds for short waits", () => {
    expect(formatElapsed(59_999)).toBe("59s");
  });

  test("uses minutes and seconds after one minute", () => {
    expect(formatElapsed(65_000)).toBe("1m 5s");
  });

  test("uses hours, minutes, and seconds after one hour", () => {
    expect(formatElapsed(3_665_000)).toBe("1h 1m 5s");
  });
});
