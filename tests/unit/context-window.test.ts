import { test, expect, describe } from "bun:test";
import { contextWindowFor, formatContextUsage } from "../../src/provider/context-window.js";

describe("contextWindowFor", () => {
  test("returns the gpt-5 family window for codex models", () => {
    expect(contextWindowFor("gpt-5-codex")).toBe(400_000);
  });

  test("falls back to a conservative window for unknown models", () => {
    expect(contextWindowFor("some-unknown-model")).toBe(128_000);
  });
});

describe("formatContextUsage", () => {
  test("is hidden at or below 60 percent", () => {
    expect(formatContextUsage(240_000, "gpt-5-codex")).toBeUndefined();
  });

  test("shows used and max tokens above 60 percent", () => {
    expect(formatContextUsage(280_000, "gpt-5-codex")).toBe("Context: 280000/400000");
  });
});
