import { describe, expect, test } from "bun:test";

import type { CodexProfile } from "../adapters/auth/codex/store.js";
import type { XaiProfile } from "../adapters/auth/xai/store.js";
import {
  codexProfileFromProviderName,
  codexProfilesToCatalogEntries,
  codexProviderName,
  codexProvidersAsSettings,
  isCodexProviderName,
} from "./codex-providers.js";
import { xaiProfilesToCatalogEntries } from "./xai-providers.js";

// Characterization tests pinning the projection behavior both provider
// wrappers must preserve through the shared implementation.

const codexProfile: CodexProfile = {
  name: "work",
  tokens: { access: "codex-access", refresh: "r", expiresAt: 1, accountId: "acct-1" },
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

describe("provider name round-trip", () => {
  test("codex", () => {
    expect(codexProviderName("work")).toBe("codex/work");
    expect(isCodexProviderName("codex/work")).toBe(true);
    expect(isCodexProviderName("xai/work")).toBe(false);
    expect(codexProfileFromProviderName("codex/work")).toBe("work");
    expect(codexProfileFromProviderName("openai")).toBeUndefined();
  });

  // xai naming/settings projection is characterized in xai-providers.test.ts;
  // here we only assert cross-provider isolation (below), not re-test it.
});

describe("settings projection", () => {
  test("codex profiles become synthetic providers seeded with the access token", () => {
    const settings = codexProvidersAsSettings([codexProfile]);
    const entry = settings["codex/work"];
    expect(entry?.name).toBe("codex/work");
    expect(entry?.apiKey).toBe("codex-access");
    expect(entry?.defaultModel).toBe(entry?.models?.[0]);
    expect(entry?.baseURL).toBeString();
  });

});

describe("catalog projection", () => {
  test("codex entries carry the profile marker and accountId only when stored", () => {
    const entries = codexProfilesToCatalogEntries([codexProfile, codexNoAccount]);
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
