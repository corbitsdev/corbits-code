import { test, expect, describe, afterEach } from "bun:test";
import {
  contextWindowFor,
  formatContextUsage,
  compactionThresholdFor,
  setModelContextWindows,
} from "../../src/provider/context-window.js";

afterEach(() => setModelContextWindows(undefined));

describe("contextWindowFor", () => {
  test("returns the gpt-5 family window for codex models", () => {
    expect(contextWindowFor("gpt-5-codex")).toBe(400_000);
  });

  test("falls back to a conservative window for unknown models", () => {
    expect(contextWindowFor("some-unknown-model")).toBe(128_000);
  });

  test("models.dev metadata overrides the family heuristic", () => {
    setModelContextWindows({ "z-ai/glm-4.6": 64_000 });
    expect(contextWindowFor("z-ai/glm-4.6")).toBe(64_000);
  });
});

describe("compactionThresholdFor", () => {
  test("targets 60 percent of the model window", () => {
    expect(compactionThresholdFor("claude-sonnet-4-6")).toBe(120_000);
  });

  test("uses models.dev window when available", () => {
    setModelContextWindows({ "small-model": 32_000 });
    expect(compactionThresholdFor("small-model")).toBe(19_200);
  });

  test("falls back to the default window when the model is unknown", () => {
    expect(compactionThresholdFor(undefined)).toBe(76_800);
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
