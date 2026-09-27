import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  loadCodexProfile,
  loadXaiProfile,
  removeCodexProfile,
  removeXaiProfile,
  saveCodexProfile,
  saveXaiProfile,
  updateCodexTokens,
  updateXaiTokens,
} from "./oauth-stores.js";

describe("OAuth profile refresh compare-and-swap", () => {
  test("stale Codex refresh cannot overwrite a newly saved profile", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-profile-cas-"));
    try {
      await saveCodexProfile(
        {
          name: "work",
          createdAt: 1,
          tokens: {
            access: "access-a",
            refresh: "refresh-a",
            expiresAt: 1,
            accountId: "account-a",
          },
        },
        home,
      );
      await removeCodexProfile("work", home);
      await saveCodexProfile(
        {
          name: "work",
          createdAt: 2,
          tokens: {
            access: "access-b",
            refresh: "refresh-b",
            expiresAt: 2,
            accountId: "account-b",
          },
        },
        home,
      );

      const winner = await updateCodexTokens(
        "work",
        {
          access: "stale-access",
          refresh: "stale-refresh",
          expiresAt: 3,
          accountId: "stale-account",
        },
        home,
        "refresh-a",
      );

      expect(winner).toEqual({
        name: "work",
        createdAt: 2,
        tokens: {
          access: "access-b",
          refresh: "refresh-b",
          expiresAt: 2,
          accountId: "account-b",
        },
      });
      expect(await loadCodexProfile("work", home)).toEqual({
        name: "work",
        createdAt: 2,
        tokens: {
          access: "access-b",
          refresh: "refresh-b",
          expiresAt: 2,
          accountId: "account-b",
        },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("stale xAI refresh cannot overwrite a newly saved profile", async () => {
    const home = await mkdtemp(join(tmpdir(), "xai-profile-cas-"));
    try {
      await saveXaiProfile(
        {
          name: "work",
          createdAt: 1,
          tokens: {
            access: "access-a",
            refresh: "refresh-a",
            expiresAt: 1,
          },
        },
        home,
      );
      await removeXaiProfile("work", home);
      await saveXaiProfile(
        {
          name: "work",
          createdAt: 2,
          tokens: {
            access: "access-b",
            refresh: "refresh-b",
            expiresAt: 2,
          },
        },
        home,
      );

      const winner = await updateXaiTokens(
        "work",
        {
          access: "stale-access",
          refresh: "stale-refresh",
          expiresAt: 3,
        },
        home,
        "refresh-a",
      );

      expect(winner).toEqual({
        name: "work",
        createdAt: 2,
        tokens: {
          access: "access-b",
          refresh: "refresh-b",
          expiresAt: 2,
        },
      });
      expect(await loadXaiProfile("work", home)).toEqual({
        name: "work",
        createdAt: 2,
        tokens: {
          access: "access-b",
          refresh: "refresh-b",
          expiresAt: 2,
        },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
