import { describe, expect, test } from "bun:test";

import { XAI_BASE_URL, XAI_DEFAULT_MODELS } from "../auth/xai/constants.js";
import type { XaiProfile } from "../auth/xai/store.js";
import { providerCatalogToSettings } from "./index.js";
import {
  isXaiProviderName,
  xaiProfileFromProviderName,
  xaiProfilesToCatalogEntries,
  xaiProviderName,
  xaiProvidersAsSettings,
} from "./xai-providers.js";

describe("xAI OAuth provider projection", () => {
  test("default models include Grok 4.6 while defaulting to the CLI coding model", () => {
    const models: string[] = [...XAI_DEFAULT_MODELS];
    expect(models).toEqual(["grok-4.5", "grok-4.6", "grok-composer-2.5-fast"]);
    expect(models[0]).toBe("grok-4.5");
  });

  const profile: XaiProfile = {
    name: "work",
    tokens: { access: "access-token", refresh: "refresh-token", expiresAt: 123 },
    createdAt: 100,
  };

  test("names and parses profile-scoped providers", () => {
    expect(xaiProviderName("work")).toBe("xai/work");
    expect(isXaiProviderName("xai/work")).toBe(true);
    expect(isXaiProviderName("codex/work")).toBe(false);
    expect(xaiProfileFromProviderName("xai/work")).toBe("work");
    expect(xaiProfileFromProviderName("openai")).toBeUndefined();
  });

  test("projects profiles into settings for provider resolution", () => {
    expect(xaiProvidersAsSettings([profile])).toEqual({
      "xai/work": {
        name: "xai/work",
        baseURL: XAI_BASE_URL,
        apiKey: "access-token",
        models: [...XAI_DEFAULT_MODELS],
        defaultModel: XAI_DEFAULT_MODELS[0],
      },
    });
  });

  test("projects catalog entries and excludes them from persisted settings", () => {
    const entries = xaiProfilesToCatalogEntries([profile]);
    expect(entries).toEqual([
      {
        name: "xai/work",
        baseURL: XAI_BASE_URL,
        apiKey: "access-token",
        models: [...XAI_DEFAULT_MODELS],
        defaultModel: XAI_DEFAULT_MODELS[0],
        xaiProfile: "work",
      },
    ]);
    expect(providerCatalogToSettings(entries, "xai/work")).toEqual({
      defaultProvider: "xai/work",
      providers: {},
    });
  });
});
