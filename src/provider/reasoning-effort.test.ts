import { afterEach, describe, test, expect } from "bun:test";
import {
  REASONING_EFFORTS,
  isReasoningEffort,
  supportedEfforts,
  validateEffort,
  setModelReasoningCapabilities,
  modelReasoningCapability,
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

  test("codex provider takes low/medium/high/xhigh, no minimal or none", () => {
    expect(supportedEfforts("gpt-5.5", undefined, true)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(supportedEfforts("gpt-5.4-mini", undefined, true)).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("the model name alone does not imply codex levels", () => {
    expect(supportedEfforts("gpt-5.5")).toEqual(["minimal", "low", "medium", "high"]);
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

describe("reasoning capability gate", () => {
  afterEach(() => setModelReasoningCapabilities({}));

  test("a model models.dev marks non-reasoning gets no effort options", () => {
    expect(supportedEfforts("gpt-4o", false)).toEqual([]);
  });

  test("an unknown capability falls back to the local heuristic", () => {
    expect(supportedEfforts("gpt-5", undefined)).toEqual(["minimal", "low", "medium", "high"]);
  });

  test("supportedEfforts reads the registry by default", () => {
    setModelReasoningCapabilities({ "chat-only-model": false });
    expect(modelReasoningCapability("chat-only-model")).toBe(false);
    expect(supportedEfforts("chat-only-model")).toEqual([]);
    expect(supportedEfforts("model-not-in-registry")).toEqual(["low", "medium", "high"]);
  });

  test("validateEffort rejects any effort for a non-reasoning model", () => {
    setModelReasoningCapabilities({ "chat-only-model": false });
    const result = validateEffort("chat-only-model", "low");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not support reasoning");
  });
});
