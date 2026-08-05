import { describe, expect, test } from "bun:test";
import { FIRST_CLASS_PROVIDERS, firstClassProviderById } from "./providers.js";

describe("FIRST_CLASS_PROVIDERS", () => {
  test("lists all first-class providers in product order", () => {
    expect(FIRST_CLASS_PROVIDERS.map((p) => p.id)).toEqual([
      "codex",
      "xai",
      "zen",
      "anthropic",
      "openai",
      "google",
      "opencode-go",
    ]);
  });

  test("Codex and xAI are OAuth; others are API key", () => {
    expect(firstClassProviderById("codex")?.auth).toBe("oauth");
    expect(firstClassProviderById("xai")?.auth).toBe("oauth");
    for (const id of ["zen", "anthropic", "openai", "google", "opencode-go"] as const) {
      expect(firstClassProviderById(id)?.auth).toBe("api-key");
    }
  });

  test("API-key providers ship baseURL, models, and defaultModel", () => {
    for (const def of FIRST_CLASS_PROVIDERS) {
      if (def.auth !== "api-key") continue;
      expect(def.baseURL?.length ?? 0).toBeGreaterThan(0);
      expect((def.models ?? []).length).toBeGreaterThan(0);
      expect(def.defaultModel?.length ?? 0).toBeGreaterThan(0);
      expect(def.models).toContain(def.defaultModel);
    }
  });

  test("Anthropic is flagged for messages adapter", () => {
    expect(firstClassProviderById("anthropic")?.anthropic).toBe(true);
  });
});
