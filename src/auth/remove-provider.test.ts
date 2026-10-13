import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  listCodexProfiles,
  loadCodexProfile,
  saveCodexProfile,
  listMetaProfiles,
  loadMetaProfile,
  saveMetaProfile,
} from "../config/oauth-stores.js";
import {
  listXaiProfiles,
  loadXaiProfile,
  saveXaiProfile,
} from "../config/oauth-stores.js";
import { oauthStoreForProvider } from "./remove-provider.js";

function oauthProvider(
  providerName: string,
  provider: "codex" | "xai",
  profile: string,
): { name: string; codexProfile?: string; xaiProfile?: string } {
  return provider === "codex"
    ? { name: providerName, codexProfile: profile }
    : { name: providerName, xaiProfile: profile };
}

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "remove-provider-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("oauthStoreForProvider", () => {
  test("maps marked xai/ and codex/ catalog entries to their stores", () => {
    expect(
      oauthStoreForProvider(oauthProvider("xai/work", "xai", "work"))?.profile,
    ).toBe("work");
    expect(
      oauthStoreForProvider(
        oauthProvider("codex/personal", "codex", "personal"),
      )?.profile,
    ).toBe("personal");
  });

  test("rejects unmarked and mismatched namespaced catalog entries", () => {
    expect(oauthStoreForProvider({ name: "codex/manual" })).toBeNull();
    expect(oauthStoreForProvider({ name: "xai/manual" })).toBeNull();
    expect(
      oauthStoreForProvider({ name: "xai/work", xaiProfile: "personal" }),
    ).toBeNull();
    expect(
      oauthStoreForProvider({ name: "codex/work", codexProfile: "personal" }),
    ).toBeNull();
  });

  test("returns null for API-key, keyless, and degenerate names", () => {
    expect(oauthStoreForProvider({ name: "openai" })).toBeNull();
    expect(oauthStoreForProvider({ name: "ollama" })).toBeNull();
    expect(oauthStoreForProvider({ name: "my-custom" })).toBeNull();
    expect(oauthStoreForProvider({ name: "xai/", xaiProfile: "" })).toBeNull();
    expect(
      oauthStoreForProvider({ name: "codex/", codexProfile: "" }),
    ).toBeNull();
  });

  test("removing an xai profile leaves sibling profiles untouched", async () => {
    await withHome(async (home) => {
      const tokens = { access: "a", refresh: "r", expiresAt: 10_000_000 };
      await saveXaiProfile({ name: "work", createdAt: 0, tokens }, home);
      await saveXaiProfile({ name: "personal", createdAt: 0, tokens }, home);

      const target = oauthStoreForProvider(
        oauthProvider("xai/work", "xai", "work"),
      );
      expect(target?.profile).toBe("work");
      expect(await target?.removeProfile(target.profile, home)).toEqual([
        "work",
      ]);
      expect(await loadXaiProfile("work", home)).toBeUndefined();
      expect(
        (await listXaiProfiles(home)).map((profile) => profile.name),
      ).toEqual(["personal"]);
    });
  });

  test("removing a codex profile leaves sibling profiles untouched", async () => {
    await withHome(async (home) => {
      const tokens = { access: "a", refresh: "r", expiresAt: 10_000_000 };
      await saveCodexProfile({ name: "day", createdAt: 0, tokens }, home);
      await saveCodexProfile({ name: "night", createdAt: 0, tokens }, home);

      const target = oauthStoreForProvider(
        oauthProvider("codex/night", "codex", "night"),
      );
      expect(await target?.removeProfile(target.profile, home)).toEqual([
        "night",
      ]);
      expect(await loadCodexProfile("night", home)).toBeUndefined();
      expect(
        (await listCodexProfiles(home)).map((profile) => profile.name),
      ).toEqual(["day"]);
    });
  });

  test("removing an already-absent profile is a no-op", async () => {
    await withHome(async (home) => {
      const target = oauthStoreForProvider(
        oauthProvider("xai/ghost", "xai", "ghost"),
      );
      expect(await target?.removeProfile(target.profile, home)).toEqual([]);
    });
  });

  test("missing auth files are tolerated", async () => {
    await withHome(async (home) => {
      // No profiles ever saved: the store treats a missing file as empty.
      const xai = oauthStoreForProvider(
        oauthProvider("xai/work", "xai", "work"),
      );
      expect(await xai?.removeProfile(xai.profile, home)).toEqual([]);
      const codex = oauthStoreForProvider(
        oauthProvider("codex/work", "codex", "work"),
      );
      expect(await codex?.removeProfile(codex.profile, home)).toEqual([]);
    });
  });

  test("removing an OAuth-backed meta row deletes that auth-store profile", async () => {
    await withHome(async (home) => {
      const tokens = { access: "LLM|a", refresh: "id", expiresAt: 10_000_000 };
      await saveMetaProfile({ name: "default", createdAt: 0, tokens }, home);
      await saveMetaProfile({ name: "work", createdAt: 0, tokens }, home);
      const target = oauthStoreForProvider({
        name: "meta/default",
        metaProfile: "default",
      });
      expect(await target?.removeProfile(target.profile, home)).toEqual([
        "default",
      ]);
      expect(await loadMetaProfile("default", home)).toBeUndefined();
      expect(
        (await listMetaProfiles(home)).map((profile) => profile.name),
      ).toEqual(["work"]);
      expect(oauthStoreForProvider({ name: "meta-api/default" })).toBeNull();
    });
  });
});
