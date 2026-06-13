import { describe, test, expect } from "bun:test";
import {
  REASONING_EFFORTS,
  isReasoningEffort,
  supportedEfforts,
  validateEffort,
} from "./reasoning-effort.js";

describe("REASONING_EFFORTS", () => {
  test("is ordered from least to most effort", () => {
    expect(REASONING_EFFORTS).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
  });
});

describe("isReasoningEffort", () => {
  test("accepts known levels", () => {
    expect(isReasoningEffort("medium")).toBe(true);
  });
  test("rejects unknown values", () => {
    expect(isReasoningEffort("ultra")).toBe(false);
    expect(isReasoningEffort(3)).toBe(false);
  });
});

describe("supportedEfforts", () => {
  test("known reasoning model gets the default set without none or xhigh", () => {
    expect(supportedEfforts("gpt-5")).toEqual(["minimal", "low", "medium", "high"]);
  });

  test("gpt-5.1 family includes none (disable) and xhigh", () => {
    expect(supportedEfforts("gpt-5.1")).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
  });

  test("unknown model gets the safe subset", () => {
    expect(supportedEfforts("some-random-model")).toEqual(["low", "medium", "high"]);
  });
});

describe("validateEffort", () => {
  test("accepts a supported level", () => {
    expect(validateEffort("gpt-5.1", "xhigh")).toEqual({ ok: true });
  });

  test("rejects an unsupported level with a clear message", () => {
    const result = validateEffort("gpt-5", "xhigh");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("does not support reasoning effort");
      expect(result.error).toContain("xhigh");
    }
  });

  test("rejects xhigh on unknown models", () => {
    expect(validateEffort("unknown", "xhigh").ok).toBe(false);
    expect(validateEffort("unknown", "minimal").ok).toBe(false);
  });
});
