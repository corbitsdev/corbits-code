import { describe, test, expect } from "bun:test";
import {
  resolveInferenceSpec,
  resolveInferenceWithPolicy,
  type Settings,
} from "../../src/config/settings.js";
import type { InferenceSpec } from "../../src/agent/profile-types.js";

const baseSettings: Settings = {
  providers: {
    anthropic: {
      baseURL: "https://api.anthropic.com",
      models: ["claude-sonnet-4", "claude-haiku-4"],
    },
    xai: { baseURL: "https://api.x.ai", models: ["grok-4"] },
    local: { baseURL: "http://localhost:11434", models: [] }, // empty models list = unrestricted
  },
};

const noFallback: Settings = { ...baseSettings, agentModelFallback: "none" };

describe("resolveInferenceSpec", () => {
  test("returns null when spec is undefined", () => {
    expect(resolveInferenceSpec(undefined, baseSettings)).toBeNull();
  });

  test("returns the first viable leg", () => {
    const spec: InferenceSpec = {
      mode: "prefer",
      order: [
        { provider: "anthropic", model: "claude-sonnet-4", reasoningEffort: "medium" },
        { provider: "xai", model: "grok-4" },
      ],
    };
    const resolved = resolveInferenceSpec(spec, baseSettings);
    expect(resolved).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4",
      reasoningEffort: "medium",
    });
  });

  test("walks past unavailable providers", () => {
    const spec: InferenceSpec = {
      mode: "prefer",
      order: [
        { provider: "openai", model: "gpt-5" }, // not in settings
        { provider: "xai", model: "grok-4" },
      ],
    };
    const resolved = resolveInferenceSpec(spec, baseSettings);
    expect(resolved).toEqual({ provider: "xai", model: "grok-4" });
  });

  test("walks past providers that don't carry the requested model", () => {
    const spec: InferenceSpec = {
      mode: "prefer",
      order: [
        { provider: "anthropic", model: "claude-opus-5" }, // not in models list
        { provider: "xai", model: "grok-4" },
      ],
    };
    const resolved = resolveInferenceSpec(spec, baseSettings);
    expect(resolved).toEqual({ provider: "xai", model: "grok-4" });
  });

  test("returns null when no leg is viable", () => {
    const spec: InferenceSpec = {
      mode: "prefer",
      order: [{ provider: "openai", model: "gpt-5" }],
    };
    expect(resolveInferenceSpec(spec, baseSettings)).toBeNull();
  });

  test("empty models list treats any model as viable (gateway provider)", () => {
    const spec: InferenceSpec = {
      mode: "prefer",
      order: [{ provider: "local", model: "anything" }],
    };
    const resolved = resolveInferenceSpec(spec, baseSettings);
    expect(resolved).toEqual({ provider: "local", model: "anything" });
  });

  test("omits reasoningEffort when the leg doesn't declare one", () => {
    const spec: InferenceSpec = {
      order: [{ provider: "anthropic", model: "claude-sonnet-4" }],
    };
    const resolved = resolveInferenceSpec(spec, baseSettings);
    expect(resolved).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
    expect(resolved).not.toHaveProperty("reasoningEffort");
  });
});

// Policy coverage for resolveInferenceWithPolicy. The function encodes an OR
// over two reasons to forbid fallback — `spec.mode === "pin"` and
// `settings.agentModelFallback === "none"` — so the truth table below pins
// every combination of those plus the spec-viable / spec-undefined axes.
// Refactoring either side of the OR without updating these will fail loudly.
describe("resolveInferenceWithPolicy", () => {
  const viableSpec: InferenceSpec = {
    mode: "prefer",
    order: [{ provider: "anthropic", model: "claude-sonnet-4" }],
  };
  const unviableSpec: InferenceSpec = {
    mode: "prefer",
    order: [{ provider: "openai", model: "gpt-5" }],
  };

  test("undefined spec → fallback (regardless of mode/setting)", () => {
    expect(resolveInferenceWithPolicy(undefined, baseSettings).kind).toBe("fallback");
    expect(resolveInferenceWithPolicy(undefined, noFallback).kind).toBe("fallback");
  });

  test("viable leg → resolved, regardless of mode or fallback setting", () => {
    const pinSpec: InferenceSpec = { ...viableSpec, mode: "pin" };
    expect(resolveInferenceWithPolicy(viableSpec, baseSettings)).toEqual({
      kind: "resolved",
      value: { provider: "anthropic", model: "claude-sonnet-4" },
    });
    expect(resolveInferenceWithPolicy(pinSpec, noFallback).kind).toBe("resolved");
  });

  test("no viable leg, mode=prefer, fallback=active → fallback", () => {
    expect(resolveInferenceWithPolicy(unviableSpec, baseSettings).kind).toBe("fallback");
  });

  test("no viable leg, mode=prefer, fallback=none → unavailable (OR side B)", () => {
    const outcome = resolveInferenceWithPolicy(unviableSpec, noFallback);
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") {
      expect(outcome.reason).toContain("openai/gpt-5");
    }
  });

  test("no viable leg, mode=pin, fallback=active → unavailable (OR side A)", () => {
    const pinSpec: InferenceSpec = { ...unviableSpec, mode: "pin" };
    expect(resolveInferenceWithPolicy(pinSpec, baseSettings).kind).toBe("unavailable");
  });

  test("no viable leg, mode=pin, fallback=none → unavailable, lists every leg", () => {
    const multiPin: InferenceSpec = {
      mode: "pin",
      order: [
        { provider: "openai", model: "gpt-5" },
        { provider: "mistral", model: "large" },
      ],
    };
    const outcome = resolveInferenceWithPolicy(multiPin, noFallback);
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") {
      expect(outcome.reason).toContain("openai/gpt-5");
      expect(outcome.reason).toContain("mistral/large");
      expect(outcome.reason.indexOf("openai/gpt-5")).toBeLessThan(
        outcome.reason.indexOf("mistral/large"),
      );
    }
  });

  test("empty order array → unavailable (no legs to land on)", () => {
    const emptyPin: InferenceSpec = { mode: "pin", order: [] };
    const outcome = resolveInferenceWithPolicy(emptyPin, baseSettings);
    // An empty `order` is logically "no viable leg" — pin surfaces it as
    // unavailable rather than silently falling through to the active session.
    expect(outcome.kind).toBe("unavailable");
  });

  test("duplicate legs resolve to the first occurrence", () => {
    const dup: InferenceSpec = {
      mode: "prefer",
      order: [
        { provider: "anthropic", model: "claude-sonnet-4" },
        { provider: "anthropic", model: "claude-sonnet-4" },
      ],
    };
    const outcome = resolveInferenceWithPolicy(dup, baseSettings);
    expect(outcome.kind).toBe("resolved");
  });
});
