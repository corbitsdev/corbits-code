import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isCodexTokenExpired,
  getValidCodexToken,
  CodexAuthError,
} from "../../src/auth/codex/session.js";
import { loadCodexProfile, saveCodexProfile } from "../../src/auth/codex/store.js";

describe("isCodexTokenExpired", () => {
  test("not expired well before expiry", () => {
    expect(isCodexTokenExpired({ access: "a", refresh: "r", expiresAt: 1_000_000 }, 500_000)).toBe(
      false,
    );
  });

  test("expired within the refresh skew window", () => {
    // 30s before expiry is inside the 60s skew, so treated as expired.
    expect(
      isCodexTokenExpired({ access: "a", refresh: "r", expiresAt: 1_000_000 }, 1_000_000 - 30_000),
    ).toBe(true);
  });

  test("expired after expiry", () => {
    expect(
      isCodexTokenExpired({ access: "a", refresh: "r", expiresAt: 1_000_000 }, 2_000_000),
    ).toBe(true);
  });
});

describe("getValidCodexToken", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = await mkdtemp(join(tmpdir(), "codex-session-"));
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
      await saveCodexProfile(
        {
          name: "p",
          createdAt: 0,
          tokens: { access: "live", refresh: "r", expiresAt: 10_000_000 },
        },
        home,
      );
      expect((await getValidCodexToken("p", 1_000, home)).access).toBe("live");
    });
  });

  test("returns the account id alongside the access token", async () => {
    await withHome(async (home) => {
      globalThis.fetch = (() => {
        throw new Error("should not be called");
      }) as unknown as typeof fetch;
      await saveCodexProfile(
        {
          name: "p",
          createdAt: 0,
          tokens: { access: "live", refresh: "r", expiresAt: 10_000_000, accountId: "acct-1" },
        },
        home,
      );
      const access = await getValidCodexToken("p", 1_000, home);
      expect(access.access).toBe("live");
      expect(access.accountId).toBe("acct-1");
    });
  });

  test("refreshes and persists when the token is expired", async () => {
    await withHome(async (home) => {
      await saveCodexProfile(
        { name: "p", createdAt: 0, tokens: { access: "old", refresh: "old-r", expiresAt: 1_000 } },
        home,
      );
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({ access_token: "fresh", refresh_token: "new-r", expires_in: 3600 }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        )) as unknown as typeof fetch;
      const token = await getValidCodexToken("p", 5_000, home);
      expect(token.access).toBe("fresh");
      const stored = await loadCodexProfile("p", home);
      expect(stored?.tokens.access).toBe("fresh");
      expect(stored?.tokens.refresh).toBe("new-r");
      expect(stored?.createdAt).toBe(0);
    });
  });

  test("throws CodexAuthError(missing) for an unknown profile", async () => {
    await withHome(async (home) => {
      const err = await getValidCodexToken("ghost", 0, home).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CodexAuthError);
      expect((err as CodexAuthError).reason).toBe("missing");
      expect((err as CodexAuthError).profile).toBe("ghost");
    });
  });

  test("throws CodexAuthError(refresh-failed) when refresh is rejected", async () => {
    await withHome(async (home) => {
      await saveCodexProfile(
        { name: "p", createdAt: 0, tokens: { access: "old", refresh: "bad", expiresAt: 1_000 } },
        home,
      );
      globalThis.fetch = (async () => new Response("revoked", { status: 400 })) as unknown as typeof fetch;
      const err = await getValidCodexToken("p", 5_000, home).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CodexAuthError);
      expect((err as CodexAuthError).reason).toBe("refresh-failed");
    });
  });
});
