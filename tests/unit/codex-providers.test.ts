import { test, expect, describe } from "bun:test";
import {
  codexProfileFromProviderName,
  codexProviderName,
  codexProvidersAsSettings,
  isCodexProviderName,
} from "../../src/config/codex-providers.js";
import { providerCatalogToSettings, type ProviderCatalogEntry } from "../../src/config/index.js";
import { CODEX_BASE_URL, CODEX_DEFAULT_MODELS } from "../../src/auth/codex/constants.js";
import type { CodexProfile } from "../../src/auth/codex/store.js";

describe("codex provider naming", () => {
  test("round-trips profile name through the codex/ prefix", () => {
    expect(codexProviderName("personal")).toBe("codex/personal");
    expect(isCodexProviderName("codex/personal")).toBe(true);
    expect(isCodexProviderName("openai")).toBe(false);
    expect(codexProfileFromProviderName("codex/work")).toBe("work");
    expect(codexProfileFromProviderName("openai")).toBeUndefined();
  });
});

describe("CODEX_DEFAULT_MODELS", () => {
  test("includes the gpt-5.6 model family while keeping gpt-5.5 as the default", () => {
    expect(CODEX_DEFAULT_MODELS).toContain("gpt-5.6-sol");
    expect(CODEX_DEFAULT_MODELS).toContain("gpt-5.6-terra");
    expect(CODEX_DEFAULT_MODELS).toContain("gpt-5.6-luna");
    expect(CODEX_DEFAULT_MODELS[0]).toBe("gpt-5.5");
  });
});

describe("codexProvidersAsSettings", () => {
  test("projects profiles into provider settings seeded with the access token", () => {
    const profiles: CodexProfile[] = [
      { name: "personal", createdAt: 0, tokens: { access: "tok-personal", refresh: "r", expiresAt: 1 } },
    ];
    const settings = codexProvidersAsSettings(profiles);
    expect(settings["codex/personal"]?.apiKey).toBe("tok-personal");
    expect(settings["codex/personal"]?.baseURL).toBe(CODEX_BASE_URL);
    expect(settings["codex/personal"]?.models.length).toBeGreaterThan(0);
  });
});

describe("providerCatalogToSettings excludes Codex entries", () => {
  test("a codex entry is never written into settings.json", () => {
    const catalog: ProviderCatalogEntry[] = [
      { name: "openai", baseURL: "https://api.openai.com/v1", apiKey: "sk-x", models: ["gpt-4o"] },
      {
        name: "codex/personal",
        baseURL: CODEX_BASE_URL,
        apiKey: "subscription-token",
        models: ["gpt-5-codex"],
        codexProfile: "personal",
      },
    ];
    const settings = providerCatalogToSettings(catalog, "openai");
    expect(Object.keys(settings.providers)).toEqual(["openai"]);
    expect(settings.providers["codex/personal"]).toBeUndefined();
  });
});
