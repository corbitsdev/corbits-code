import { test, expect, describe, afterEach } from "bun:test";
import type { TokenUsage } from "@intx/types/runtime";
import {
  contextWindowFor,
  compactionThresholdFor,
  compactionWideResumeDeltaFor,
  hasWideResumeGap,
  isAtOrUnderCompactThreshold,
  contextTokensFromUsage,
  contextMeterBand,
  COMPACTION_WINDOW_FRACTION,
  CONTEXT_METER_DANGER_FRACTION,
  setModelContextWindows,
  setProviderContextWindowOverrides,
  clearSessionContextWindowPins,
} from "./context-window.js";

function usage(overrides: Partial<TokenUsage>): TokenUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    thinking: 0,
    ...overrides,
  };
}

afterEach(() => {
  setModelContextWindows(undefined);
  setProviderContextWindowOverrides(undefined);
  clearSessionContextWindowPins();
});

describe("contextWindowFor", () => {
  test("returns the gpt-5 family window for codex models", () => {
    expect(contextWindowFor("gpt-5-codex")).toBe(400_000);
  });

  test("glm-5.3 family uses a 1M window while other glm models keep the 200k heuristic", () => {
    expect(contextWindowFor("glm-5.3")).toBe(1_000_000);
    expect(contextWindowFor("glm-5.2")).toBe(200_000);
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

  test("is 60 percent of the window minus the reserved completion budget", () => {
    setModelContextWindows({ "qwen-test": 262_144 });
    const reserved = 32_768;
    const usable = 262_144 - reserved;
    const threshold = compactionThresholdFor("qwen-test", reserved);
    expect(threshold).toBe(Math.floor(usable * COMPACTION_WINDOW_FRACTION));
    expect(threshold).toBeLessThan(usable);
    expect(compactionThresholdFor("qwen-test", 0)).toBe(
      Math.floor(262_144 * COMPACTION_WINDOW_FRACTION),
    );
  });
});

describe("compactionWideResumeDeltaFor", () => {
  test("is a full warning band of the model window, danger-anchored", () => {
    expect(compactionWideResumeDeltaFor("claude-sonnet-4-6")).toBe(40_000);
  });

  test("falls back to the default window when the model is unknown", () => {
    expect(compactionWideResumeDeltaFor(undefined)).toBe(25_600);
  });
});

describe("hasWideResumeGap", () => {
  test("growth below the wide gap does not re-arm", () => {
    const postCompact = compactionThresholdFor("m") + 1;
    expect(
      hasWideResumeGap(
        postCompact,
        postCompact + compactionWideResumeDeltaFor("m") - 1,
        "m",
      ),
    ).toBe(false);
  });

  test("a wide gap past the post-compact measurement re-arms", () => {
    const postCompact = compactionThresholdFor("m") + 1;
    expect(
      hasWideResumeGap(
        postCompact,
        postCompact + compactionWideResumeDeltaFor("m"),
        "m",
      ),
    ).toBe(true);
  });
});

describe("isAtOrUnderCompactThreshold", () => {
  test("the threshold itself counts as fold evidence", () => {
    expect(isAtOrUnderCompactThreshold(compactionThresholdFor("m"), "m")).toBe(
      true,
    );
    expect(
      isAtOrUnderCompactThreshold(compactionThresholdFor("m") + 1, "m"),
    ).toBe(false);
  });
});

describe("contextTokensFromUsage", () => {
  test("sums input plus both cache fields, not just input", () => {
    // Prompt caching (e.g. Anthropic) bills and counts cache reads/writes
    // against the window; a formula that only looks at `input` understates
    // occupancy on any session using it.
    expect(
      contextTokensFromUsage(
        usage({ input: 100, cacheRead: 50, cacheWrite: 25 }),
      ),
    ).toBe(175);
  });

  test("is zero for empty usage", () => {
    expect(contextTokensFromUsage(usage({}))).toBe(0);
  });
});

describe("context meter fractions", () => {
  test("danger sits between compaction and hard overflow", () => {
    expect(CONTEXT_METER_DANGER_FRACTION).toBeGreaterThan(
      COMPACTION_WINDOW_FRACTION,
    );
    expect(CONTEXT_METER_DANGER_FRACTION).toBeLessThan(1);
  });
});

describe("contextMeterBand", () => {
  test("0–60 is quiet, 61–80 warning, 81–100 danger", () => {
    expect(contextMeterBand(0)).toBe("quiet");
    expect(contextMeterBand(60)).toBe("quiet");
    expect(contextMeterBand(61)).toBe("warning");
    expect(contextMeterBand(80)).toBe("warning");
    expect(contextMeterBand(81)).toBe("danger");
    expect(contextMeterBand(100)).toBe("danger");
  });
});
