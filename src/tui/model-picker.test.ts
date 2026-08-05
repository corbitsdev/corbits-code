import { describe, test, expect } from "bun:test";

import { buildModelsFirstList, type ModelPickerProvider } from "./model-picker.js";

const xai: ModelPickerProvider = {
  name: "xai",
  label: "xAI",
  models: ["grok-4", "grok-3"],
  account: "thegreataxios",
};

const zen: ModelPickerProvider = {
  name: "zen",
  label: "OpenCode Zen",
  models: ["kimi-k2.7-code", "claude-sonnet-4-5"],
  baseURL: "https://opencode.ai/zen/v1",
};

const go: ModelPickerProvider = {
  name: "opencode-go",
  label: "OpenCode Go",
  models: ["kimi-k2.7-code", "glm-5"],
  opencodeGo: true,
};

describe("buildModelsFirstList", () => {
  test("orders Recent, then Favorites, then provider buckets", () => {
    const list = buildModelsFirstList({
      providers: [xai, zen],
      recent: [{ provider: "zen", model: "claude-sonnet-4-5" }],
      favorites: [{ provider: "xai", model: "grok-4" }],
    });

    expect(list.map((r) => `${r.section}:${r.provider}/${r.model}`)).toEqual([
      "recent:zen/claude-sonnet-4-5",
      "favorites:xai/grok-4",
      "provider:xai/grok-3",
      "provider:zen/kimi-k2.7-code",
    ]);
  });

  test("drops recent entries whose model no longer exists on the provider", () => {
    const list = buildModelsFirstList({
      providers: [xai],
      recent: [
        { provider: "xai", model: "gone-model" },
        { provider: "xai", model: "grok-4" },
      ],
      favorites: [],
    });

    expect(list.filter((r) => r.section === "recent")).toEqual([
      {
        provider: "xai",
        model: "grok-4",
        section: "recent",
        providerLabel: "xAI",
        account: "thegreataxios",
      },
    ]);
  });

  test("skips favorites already covered by recent", () => {
    const list = buildModelsFirstList({
      providers: [xai],
      recent: [{ provider: "xai", model: "grok-4" }],
      favorites: [{ provider: "xai", model: "grok-4" }],
    });

    expect(list.filter((r) => r.provider === "xai" && r.model === "grok-4")).toEqual([
      {
        provider: "xai",
        model: "grok-4",
        section: "recent",
        providerLabel: "xAI",
        account: "thegreataxios",
      },
    ]);
  });

  test("skips provider-bucket models already shown in recent or favorites", () => {
    const list = buildModelsFirstList({
      providers: [xai],
      recent: [{ provider: "xai", model: "grok-4" }],
      favorites: [{ provider: "xai", model: "grok-3" }],
    });

    expect(list.filter((r) => r.section === "provider")).toEqual([]);
    expect(list.map((r) => r.section)).toEqual(["recent", "favorites"]);
  });

  test("caps recent at recentMax (default 5)", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      provider: "xai",
      model: `m${i}`,
    }));
    const provider: ModelPickerProvider = {
      name: "xai",
      models: many.map((r) => r.model),
    };
    const list = buildModelsFirstList({
      providers: [provider],
      recent: many,
      favorites: [],
    });

    expect(list.filter((r) => r.section === "recent")).toHaveLength(5);
  });

  test("attaches zen-path warning when predicate returns true", () => {
    const list = buildModelsFirstList({
      providers: [zen, go],
      recent: [{ provider: "zen", model: "kimi-k2.7-code" }],
      favorites: [],
      isGoModelOnZenPath: (model, provider) =>
        model === "kimi-k2.7-code" && provider.name === "zen",
    });

    const recent = list.find((r) => r.section === "recent");
    expect(recent?.warning).toMatch(/Go model on Zen path/);

    const goRow = list.find(
      (r) => r.section === "provider" && r.provider === "opencode-go" && r.model === "kimi-k2.7-code",
    );
    expect(goRow?.warning).toBeUndefined();
  });

  test("uses provider name as label when label is unset", () => {
    const list = buildModelsFirstList({
      providers: [{ name: "custom", models: ["m1"] }],
      recent: [],
      favorites: [],
    });
    expect(list[0]?.providerLabel).toBe("custom");
  });
});
