import { describe, expect, test } from "bun:test";

import { META_BASE_URL, META_DEFAULT_MODELS } from "../auth/meta/constants.js";
import type { MetaProfile } from "../auth/meta/store.js";
import { providerCatalogToSettings } from "./index.js";
import {
  isMetaProviderName,
  metaProfileFromProviderName,
  metaProfilesToCatalogEntries,
  metaProviderName,
  metaProvidersAsSettings,
} from "./meta-providers.js";

describe("Meta OAuth provider projection", () => {
  test("default models lead with the Muse coding model", () => {
    expect(META_DEFAULT_MODELS.length).toBeGreaterThan(1);
    expect(META_DEFAULT_MODELS[0]).toBe("muse-spark-1.3");
  });

  const profile: MetaProfile = {
    name: "work",
    tokens: {
      access: "access-token",
      refresh: "identity-token",
      expiresAt: 123,
    },
    createdAt: 100,
  };

  test("names and parses profile-scoped providers", () => {
    expect(metaProviderName("work")).toBe("meta/work");
    expect(isMetaProviderName("meta/work")).toBe(true);
    expect(isMetaProviderName("codex/work")).toBe(false);
    expect(metaProfileFromProviderName("meta/work")).toBe("work");
    expect(metaProfileFromProviderName("openai")).toBeUndefined();
  });

  test("projects profiles into settings for provider resolution", () => {
    expect(metaProvidersAsSettings([profile])).toEqual({
      "meta/work": {
        name: "meta/work",
        baseURL: META_BASE_URL,
        apiKey: "access-token",
        models: [...META_DEFAULT_MODELS],
        defaultModel: META_DEFAULT_MODELS[0],
      },
    });
  });

  test("projects catalog entries and excludes them from persisted settings", () => {
    const entries = metaProfilesToCatalogEntries([profile]);
    expect(entries).toEqual([
      {
        name: "meta/work",
        baseURL: META_BASE_URL,
        apiKey: "access-token",
        models: [...META_DEFAULT_MODELS],
        defaultModel: META_DEFAULT_MODELS[0],
        metaProfile: "work",
      },
    ]);
    expect(providerCatalogToSettings(entries, "meta/work")).toEqual({
      defaultProvider: "meta/work",
      providers: {},
    });
  });
});
