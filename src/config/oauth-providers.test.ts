import { describe, expect, test } from "bun:test";

import type { CodexProfile } from "../auth/codex/store.js";
import type { XaiProfile } from "../auth/xai/store.js";
import { codexProfilesToCatalogEntries } from "./codex-providers.js";
import { createOAuthProviderProjection } from "./oauth-providers.js";
import { xaiProfilesToCatalogEntries } from "./xai-providers.js";

// Characterization tests pinning the projection behavior both provider
// wrappers must preserve. Name round-trips and settings projection are
// characterized in codex-providers.test.ts and xai-providers.test.ts — only
// cross-provider marker isolation and the per-profile models contract live
// here.

const codexProfile: CodexProfile = {
  name: "work",
  tokens: {
    access: "codex-access",
    refresh: "r",
    expiresAt: 1,
    accountId: "acct-1",
  },
  createdAt: 0,
};
const codexNoAccount: CodexProfile = {
  name: "personal",
  tokens: { access: "codex-access-2", refresh: "r", expiresAt: 1 },
  createdAt: 0,
};
const xaiProfile: XaiProfile = {
  name: "work",
  tokens: { access: "xai-access", refresh: "r", expiresAt: 1 },
  createdAt: 0,
};

describe("catalog projection", () => {
  test("codex entries carry the profile marker and accountId only when stored", () => {
    const entries = codexProfilesToCatalogEntries([
      codexProfile,
      codexNoAccount,
    ]);
    expect(entries[0]?.codexProfile).toBe("work");
    expect(entries[0]?.codexAccountId).toBe("acct-1");
    expect(entries[1]?.codexProfile).toBe("personal");
    expect("codexAccountId" in (entries[1] ?? {})).toBe(false);
  });

  test("xai entries carry the xai profile marker and never a codex marker", () => {
    const entries = xaiProfilesToCatalogEntries([xaiProfile]);
    expect(entries[0]?.xaiProfile).toBe("work");
    expect(entries[0]?.codexProfile).toBeUndefined();
    expect(entries[0]?.codexAccountId).toBeUndefined();
  });
});

describe("per-profile models", () => {
  const profiles = [
    { name: "a", tokens: { access: "ta" } },
    { name: "b", tokens: { access: "tb" } },
  ];
  const perProfile: Record<string, readonly [string, ...string[]]> = {
    a: ["m-a1", "m-a2"],
    b: ["m-b1"],
  };
  const projection = createOAuthProviderProjection({
    prefix: "p/",
    baseURL: "https://example.invalid",
    models: (profile) => {
      const list = perProfile[profile.name];
      if (list === undefined) throw new Error(`no models for ${profile.name}`);
      return list;
    },
    catalogExtras: () => ({}),
  });

  test("the settings projection lists each profile's models with the first as default", () => {
    const settings = projection.providersAsSettings(profiles);
    expect(settings["p/a"]?.models).toEqual(["m-a1", "m-a2"]);
    expect(settings["p/a"]?.defaultModel).toBe("m-a1");
    expect(settings["p/b"]?.models).toEqual(["m-b1"]);
    expect(settings["p/b"]?.defaultModel).toBe("m-b1");
  });

  test("the catalog projection lists each profile's models with the first as default", () => {
    const entries = projection.profilesToCatalogEntries(profiles);
    expect(entries.map((e) => [e.name, e.models, e.defaultModel])).toEqual([
      ["p/a", ["m-a1", "m-a2"], "m-a1"],
      ["p/b", ["m-b1"], "m-b1"],
    ]);
  });

  test("projected lists are copies the caller can mutate without touching the source", () => {
    projection.providersAsSettings(profiles)["p/a"]?.models.push("mutated");
    expect(perProfile["a"]).toEqual(["m-a1", "m-a2"]);
  });
});
