import { test, expect, describe, afterEach } from "bun:test";
import type { TokenUsage } from "@intx/types/runtime";
import {
  contextWindowFor,
  compactionThresholdFor,
  contextTokensFromUsage,
  COMPACTION_WINDOW_FRACTION,
  CONTEXT_METER_DANGER_FRACTION,
  setModelContextWindows,
} from "../../src/provider/context-window.js";

function usage(overrides: Partial<TokenUsage>): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, ...overrides };
}

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

describe("contextTokensFromUsage", () => {
  test("sums input plus both cache fields, not just input", () => {
    // Prompt caching (e.g. Anthropic) bills and counts cache reads/writes
    // against the window; a formula that only looks at `input` understates
    // occupancy on any session using it.
    expect(contextTokensFromUsage(usage({ input: 100, cacheRead: 50, cacheWrite: 25 }))).toBe(175);
  });

  test("is zero for empty usage", () => {
    expect(contextTokensFromUsage(usage({}))).toBe(0);
  });
});

describe("context meter fractions", () => {
  test("warning aligns with the compaction window fraction", () => {
    expect(COMPACTION_WINDOW_FRACTION).toBe(0.6);
  });

  test("danger sits between compaction and hard overflow", () => {
    expect(CONTEXT_METER_DANGER_FRACTION).toBeGreaterThan(COMPACTION_WINDOW_FRACTION);
    expect(CONTEXT_METER_DANGER_FRACTION).toBeLessThan(1);
    expect(CONTEXT_METER_DANGER_FRACTION).toBe(0.9);
  });
});
