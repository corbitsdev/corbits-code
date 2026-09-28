import { describe, expect, test } from "bun:test";

import type { CodexProfile } from "../auth/codex/store.js";
import type { XaiProfile } from "../auth/xai/store.js";
import { codexProfilesToCatalogEntries } from "./codex-providers.js";
import { xaiProfilesToCatalogEntries } from "./xai-providers.js";

// Characterization tests pinning the projection behavior both provider
// wrappers must preserve through the shared implementation. Name round-trips
// and settings projection are characterized in codex-providers.test.ts and
// xai-providers.test.ts — only cross-provider marker isolation lives here.

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
