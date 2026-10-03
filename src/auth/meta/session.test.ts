import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isMetaTokenExpired,
  getValidMetaToken,
  MetaAuthError,
} from "./session.js";
import { loadMetaProfile, saveMetaProfile } from "../../config/oauth-stores.js";

describe("isMetaTokenExpired", () => {
  test("not expired well before expiry", () => {
    expect(
      isMetaTokenExpired(
        { access: "a", refresh: "r", expiresAt: 1_000_000 },
        500_000,
      ),
    ).toBe(false);
  });

  test("expired within the refresh skew window", () => {
    // 4 minutes before expiry is inside the 5-minute skew, so treated as expired.
    expect(
      isMetaTokenExpired(
        { access: "a", refresh: "r", expiresAt: 1_000_000 },
        1_000_000 - 4 * 60_000,
      ),
    ).toBe(true);
  });

  test("expired after expiry", () => {
    expect(
      isMetaTokenExpired(
        { access: "a", refresh: "r", expiresAt: 1_000_000 },
        2_000_000,
      ),
    ).toBe(true);
  });
});

describe("getValidMetaToken", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = await mkdtemp(join(tmpdir(), "meta-session-"));
    try {
      return await fn(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  test("returns the stored token when still valid (no network)", async () => {
    await withHome(async (home) => {
      globalThis.fetch = (() => {
        throw new Error("should not be called");
      }) as unknown as typeof fetch;
      await saveMetaProfile(
        {
          name: "p",
          createdAt: 0,
          tokens: { access: "live", refresh: "r", expiresAt: 10_000_000 },
        },
        home,
      );
      expect((await getValidMetaToken("p", 1_000, home)).access).toBe("live");
    });
  });

  test("re-mints and persists when the token is expired", async () => {
    await withHome(async (home) => {
      await saveMetaProfile(
        {
          name: "p",
          createdAt: 0,
          tokens: { access: "old", refresh: "id-token", expiresAt: 1_000 },
        },
        home,
      );
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ api_key: "LLM|fresh" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
      const token = await getValidMetaToken("p", 5_000, home);
      expect(token.access).toBe("LLM|fresh");
      const stored = await loadMetaProfile("p", home);
      expect(stored?.tokens.access).toBe("LLM|fresh");
      expect(stored?.tokens.refresh).toBe("id-token");
      expect(stored?.createdAt).toBe(0);
    });
  });

  test("throws MetaAuthError(missing) for an unknown profile", async () => {
    await withHome(async (home) => {
      const err = await getValidMetaToken("ghost", 0, home).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(MetaAuthError);
      expect((err as MetaAuthError).reason).toBe("missing");
      expect((err as MetaAuthError).profile).toBe("ghost");
    });
  });

  test("throws MetaAuthError(refresh-failed) when re-mint rejects with 401", async () => {
    await withHome(async (home) => {
      await saveMetaProfile(
        {
          name: "p",
          createdAt: 0,
          tokens: { access: "old", refresh: "dead-id", expiresAt: 1_000 },
        },
        home,
      );
      globalThis.fetch = (async () =>
        new Response("expired", { status: 401 })) as unknown as typeof fetch;
      const err = await getValidMetaToken("p", 5_000, home).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(MetaAuthError);
      expect((err as MetaAuthError).reason).toBe("refresh-failed");
    });
  });

  test("throws MetaAuthError(refresh-failed) when re-mint rejects with 403", async () => {
    await withHome(async (home) => {
      await saveMetaProfile(
        {
          name: "p",
          createdAt: 0,
          tokens: { access: "old", refresh: "dead-id", expiresAt: 1_000 },
        },
        home,
      );
      globalThis.fetch = (async () =>
        new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
      const err = await getValidMetaToken("p", 5_000, home).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(MetaAuthError);
      expect((err as MetaAuthError).reason).toBe("refresh-failed");
    });
  });
});
