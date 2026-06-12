import { describe, test, expect } from "bun:test";
import { resolveLabel } from "./in-flight-indicator.js";

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
