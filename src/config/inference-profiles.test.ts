import { describe, expect, test } from "bun:test";

import {
  applyInferenceProfile,
  type InferenceProfile,
  isSettings,
  resolveInferenceProfile,
  type Settings,
} from "./settings.js";

function settingsWith(
  inferenceProfiles: Record<string, InferenceProfile>,
): Settings {
  return {
    providers: {
      primary: {
        baseURL: "https://primary.example/v1",
        apiKey: "k",
        models: ["parent-model", "other-model"],
      },
    },
    inferenceProfiles,
  };
}

describe("resolveInferenceProfile (CL-9880)", () => {
  test("returns undefined when no table is configured", () => {
    const settings: Settings = {
      providers: {
        primary: { baseURL: "https://x.example/v1", models: ["m"] },
      },
    };
    expect(
      resolveInferenceProfile(settings, {
        directorId: "coder",
        modelRole: "implement",
      }),
    ).toBeUndefined();
    expect(
      resolveInferenceProfile(undefined, { directorId: "coder" }),
    ).toBeUndefined();
  });

  test("director id wins over modelRole", () => {
    const settings = settingsWith({
      coder: { model: "coder-model" },
      implement: { model: "role-model" },
    });
    expect(
      resolveInferenceProfile(settings, {
        directorId: "coder",
        modelRole: "implement",
      }),
    ).toEqual({ model: "coder-model" });
  });

  test("modelRole is the fallback key", () => {
    const settings = settingsWith({ implement: { model: "role-model" } });
    expect(
      resolveInferenceProfile(settings, {
        directorId: "coder",
        modelRole: "implement",
      }),
    ).toEqual({ model: "role-model" });
    expect(
      resolveInferenceProfile(settings, {
        directorId: "explorer",
        modelRole: "explore",
      }),
    ).toBeUndefined();
  });

  test("decide flag is accepted and carried (reserved no-op)", () => {
    const settings = settingsWith({ coder: { decide: true } });
    expect(resolveInferenceProfile(settings, { directorId: "coder" })).toEqual({
      decide: true,
    });
  });

  test("settings schema accepts inferenceProfiles", () => {
    expect(
      isSettings({
        providers: {
          primary: { baseURL: "https://x.example/v1", models: ["m"] },
        },
        inferenceProfiles: {
          coder: { provider: "primary", model: "m", reasoningEffort: "high" },
          implement: { reasoningEffort: "medium", decide: true },
        },
      }),
    ).toBe(true);
    expect(
      isSettings({
        providers: {
          primary: { baseURL: "https://x.example/v1", models: ["m"] },
        },
        inferenceProfiles: { coder: { reasoningEffort: "bogus" } },
      }),
    ).toBe(false);
  });

  test("settings schema rejects empty provider/model strings", () => {
    const base = {
      providers: {
        primary: { baseURL: "https://x.example/v1", models: ["m"] },
      },
    };
    expect(
      isSettings({ ...base, inferenceProfiles: { coder: { model: "" } } }),
    ).toBe(false);
    expect(
      isSettings({ ...base, inferenceProfiles: { coder: { provider: "" } } }),
    ).toBe(false);
  });
});

describe("applyInferenceProfile (CL-9880)", () => {
  const parent = { provider: "primary", model: "parent-model" };

  test("undefined profile keeps the parent default", () => {
    expect(applyInferenceProfile(undefined, parent)).toBeNull();
  });

  test("empty profile keeps the parent default", () => {
    expect(applyInferenceProfile({}, parent)).toBeNull();
  });

  test("omitted provider/model inherit the parent pair", () => {
    expect(applyInferenceProfile({ reasoningEffort: "high" }, parent)).toEqual({
      provider: "primary",
      model: "parent-model",
      reasoningEffort: "high",
    });
    expect(applyInferenceProfile({ decide: true }, parent)).toBeNull();
  });

  test("override wins over the parent pair", () => {
    expect(applyInferenceProfile({ model: "other-model" }, parent)).toEqual({
      provider: "primary",
      model: "other-model",
    });
    expect(
      applyInferenceProfile(
        { provider: "second", model: "s-model", reasoningEffort: "high" },
        parent,
      ),
    ).toEqual({
      provider: "second",
      model: "s-model",
      reasoningEffort: "high",
    });
  });
});
