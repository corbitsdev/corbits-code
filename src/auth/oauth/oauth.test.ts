import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { baseTokensFromResponse, postToken, type OAuthClientConfig } from "./client.js";
import { startOAuthLogin } from "./login.js";
import { createTokenSession } from "./session.js";
import { createAuthStore, type AuthProfile, type BaseTokens } from "./store.js";

const config: OAuthClientConfig = {
  clientId: "client-id",
  authorizeUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  redirectUri: "http://127.0.0.1:1455/callback",
  scopes: ["openid"],
  tokenTimeoutMs: 1_000,
  label: "Codex",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(payload: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("postToken response validation", () => {
  test("rejects a malformed expires_in instead of letting NaN expiry through", async () => {
    // Regression guard: the pre-shared Codex client only checked access_token
    // was a string, so `expires_in: "soon"` survived and produced a NaN expiry
    // that never read as expired. The shared client must reject the payload.
    stubFetch({ access_token: "tok", refresh_token: "ref", expires_in: "soon" });
    await expect(postToken(config, new URLSearchParams())).rejects.toThrow(
      /Codex token endpoint returned an unexpected payload/,
    );
  });

  test("rejects a payload with no access_token", async () => {
    stubFetch({ refresh_token: "ref" });
    await expect(postToken(config, new URLSearchParams())).rejects.toThrow(/unexpected payload/);
  });

  test("accepts a minimal valid payload", async () => {
    stubFetch({ access_token: "tok" });
    const response = await postToken(config, new URLSearchParams());
    expect(response.access_token).toBe("tok");
  });

  test("reports the provider label and status on a non-2xx response", async () => {
    stubFetch({ error: "server_error" }, 500);
    await expect(postToken(config, new URLSearchParams())).rejects.toThrow(
      /Codex token endpoint returned 500/,
    );
  });
});

describe("baseTokensFromResponse", () => {
  test("computes expiry from expires_in and keeps the issued refresh token", () => {
    const tokens = baseTokensFromResponse(
      { access_token: "a", refresh_token: "r", expires_in: 60 },
      1_000,
      undefined,
      "Codex",
    );
    expect(tokens).toEqual({ access: "a", refresh: "r", expiresAt: 61_000 });
  });

  test("defaults the lifetime when expires_in is omitted and carries the prior refresh forward", () => {
    const tokens = baseTokensFromResponse({ access_token: "a" }, 0, "prior-refresh", "Codex");
    expect(tokens.refresh).toBe("prior-refresh");
    expect(tokens.expiresAt).toBe(3_600_000);
  });

  test("throws when no refresh token exists anywhere", () => {
    expect(() => baseTokensFromResponse({ access_token: "a" }, 0, undefined, "Codex")).toThrow(
      /no refresh_token/,
    );
  });
});

type TestTokens = BaseTokens & { accountId?: string };

function isTestTokens(value: unknown): value is TestTokens {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.access === "string" && typeof t.refresh === "string" && typeof t.expiresAt === "number"
  );
}

describe("createAuthStore", () => {
  test("round-trips profiles under an injected home and survives corrupt files", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-store-"));
    try {
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        isTokens: isTestTokens,
      });
      expect(store.authPath(home)).toBe(join(home, ".corbits", "test-auth.json"));
      expect(await store.listProfiles(home)).toEqual([]);

      const profile = {
        name: "work",
        tokens: { access: "a", refresh: "r", expiresAt: 1 },
        createdAt: 10,
      };
      await store.saveProfile(profile, home);
      expect(await store.loadProfile("work", home)).toEqual(profile);

      await store.updateTokens("work", { access: "a2", refresh: "r2", expiresAt: 2 }, home);
      const updated = await store.loadProfile("work", home);
      expect(updated?.tokens.access).toBe("a2");
      expect(updated?.createdAt).toBe(10);

      // updateTokens is a no-op for a profile that no longer exists.
      await store.updateTokens("gone", { access: "x", refresh: "x", expiresAt: 0 }, home);
      expect(await store.loadProfile("gone", home)).toBeUndefined();

      expect(await store.removeProfile("work", home)).toEqual(["work"]);
      expect(await store.removeProfile("work", home)).toEqual([]);

      // A corrupt file reads as empty state rather than throwing.
      await writeFile(store.authPath(home), "{not json", { mode: 0o600 });
      expect(await store.listProfiles(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("concurrent saveProfile calls preserve all profiles", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-lock-"));
    try {
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        isTokens: isTestTokens,
      });

      // Fire concurrent saves for distinct profile names. Without the store
      // lock the last writer would silently drop profiles saved by others.
      const count = 20;
      const saves = Array.from({ length: count }, (_, i) =>
        store.saveProfile(
          {
            name: `p-${i}`,
            tokens: { access: `a-${i}`, refresh: `r-${i}`, expiresAt: i },
            createdAt: i,
          },
          home,
        ),
      );
      await Promise.all(saves);

      const profiles = await store.listProfiles(home);
      expect(profiles).toHaveLength(count);
      for (let i = 0; i < count; i++) {
        const p = profiles.find((p) => p.name === `p-${i}`);
        expect(p).toBeDefined();
        expect(p!.tokens.access).toBe(`a-${i}`);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("concurrent updateTokens and saveProfile do not lose profiles", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-lock-"));
    try {
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        isTokens: isTestTokens,
      });

      // Seed two profiles.
      await store.saveProfile(
        { name: "a", tokens: { access: "a0", refresh: "r0", expiresAt: 1 }, createdAt: 1 },
        home,
      );
      await store.saveProfile(
        { name: "b", tokens: { access: "b0", refresh: "r0", expiresAt: 1 }, createdAt: 2 },
        home,
      );

      // Concurrently update tokens for both profiles plus a full save of "a".
      await Promise.all([
        store.updateTokens("a", { access: "a1", refresh: "r1", expiresAt: 10 }, home),
        store.updateTokens("b", { access: "b1", refresh: "r1", expiresAt: 10 }, home),
        store.saveProfile(
          { name: "a", tokens: { access: "a2", refresh: "r2", expiresAt: 20 }, createdAt: 1 },
          home,
        ),
      ]);

      const profiles = await store.listProfiles(home);
      const names = profiles.map((p) => p.name).sort();
      expect(names).toEqual(["a", "b"]);

      for (const p of profiles) {
        expect(typeof p.tokens.access).toBe("string");
        expect(typeof p.tokens.refresh).toBe("string");
        expect(typeof p.tokens.expiresAt).toBe("number");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("lock file is cleaned up after operations", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-lock-cleanup-"));
    try {
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        isTokens: isTestTokens,
      });

      await store.saveProfile(
        { name: "x", tokens: { access: "a", refresh: "r", expiresAt: 1 }, createdAt: 1 },
        home,
      );

      // The lock file must not linger after the operation.
      const lockFile = join(home, ".corbits", "test-auth.json.lock");
      await expect(readFile(lockFile, "utf8")).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("concurrent removeProfile does not leave stale profiles", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-lock-"));
    try {
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        isTokens: isTestTokens,
      });

      const count = 10;
      for (let i = 0; i < count; i++) {
        await store.saveProfile(
          {
            name: `r-${i}`,
            tokens: { access: `a-${i}`, refresh: `r-${i}`, expiresAt: i },
            createdAt: i,
          },
          home,
        );
      }

      // Concurrently remove all profiles.
      const removals = Array.from({ length: count }, (_, i) => store.removeProfile(`r-${i}`, home));
      const results = await Promise.all(removals);

      // Each removal should have returned exactly one name.
      for (const removed of results) {
        expect(removed).toHaveLength(1);
      }

      expect(await store.listProfiles(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("drops invalid profile entries instead of wedging on them", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-store-"));
    try {
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        isTokens: isTestTokens,
      });
      await store.saveProfile(
        { name: "good", tokens: { access: "a", refresh: "r", expiresAt: 1 }, createdAt: 1 },
        home,
      );
      const raw = JSON.parse(await readFile(store.authPath(home), "utf8")) as {
        profiles: Record<string, unknown>;
      };
      raw.profiles.bad = { name: "bad", tokens: { access: 42 }, createdAt: "nope" };
      await writeFile(store.authPath(home), JSON.stringify(raw), { mode: 0o600 });
      const names = (await store.listProfiles(home)).map((p) => p.name);
      expect(names).toEqual(["good"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("startOAuthLogin", () => {
  test("stages the exchanged profile until commit is invoked", async () => {
    const saved: AuthProfile<TestTokens>[] = [];
    let closed = 0;
    const tokens = { access: "new-access", refresh: "new-refresh", expiresAt: 10_000 };
    const handle = await startOAuthLogin(
      {
        profile: "work",
        signal: new AbortController().signal,
        now: () => 123,
        openBrowser: false,
      },
      {
        startCallbackServer: async () => ({
          waitForCode: async () => "authorization-code",
          close: () => {
            closed += 1;
          },
        }),
        buildAuthorizeUrl: () => "https://auth.example.com/authorize",
        exchangeCode: async () => tokens,
        saveProfile: async (profile) => {
          saved.push(profile);
        },
      },
    );

    const staged = await handle.completed;
    expect(saved).toEqual([]);
    expect(staged.profile).toEqual({ name: "work", tokens, createdAt: 123 });
    expect(closed).toBe(1);

    await Promise.all([staged.commit(), staged.commit()]);
    expect(saved).toEqual([staged.profile]);
  });

  test("allows a failed profile commit to be retried", async () => {
    let saveAttempts = 0;
    const handle = await startOAuthLogin(
      {
        profile: "work",
        signal: new AbortController().signal,
        now: () => 123,
        openBrowser: false,
      },
      {
        startCallbackServer: async () => ({
          waitForCode: async () => "authorization-code",
          close: () => undefined,
        }),
        buildAuthorizeUrl: () => "https://auth.example.com/authorize",
        exchangeCode: async () => ({ access: "new", refresh: "refresh", expiresAt: 10_000 }),
        saveProfile: async () => {
          saveAttempts += 1;
          if (saveAttempts === 1) throw new Error("transient save failure");
        },
      },
    );

    const staged = await handle.completed;
    await expect(staged.commit()).rejects.toThrow("transient save failure");
    await expect(staged.commit()).resolves.toBeUndefined();
    expect(saveAttempts).toBe(2);
  });
});

describe("createTokenSession", () => {
  function makeSession(overrides?: {
    refreshTokens?: (refreshToken: string, now: number) => Promise<TestTokens>;
    mergeRefreshed?: (refreshed: TestTokens, previous: TestTokens) => TestTokens;
    profile?: { tokens: TestTokens };
  }) {
    const calls = { refresh: 0, updates: [] as TestTokens[] };
    let stored: { tokens: TestTokens } | undefined = overrides?.profile ?? {
      tokens: { access: "old", refresh: "ref", expiresAt: 1_000 },
    };
    const session = createTokenSession<TestTokens, string>({
      skewMs: 100,
      loadProfile: async () => stored,
      updateTokens: async (_name, tokens) => {
        calls.updates.push(tokens);
        stored = { tokens };
      },
      refreshTokens:
        overrides?.refreshTokens ??
        (async () => {
          calls.refresh += 1;
          return { access: "new", refresh: "ref2", expiresAt: 10_000 };
        }),
      toAccess: (tokens) => tokens.access,
      ...(overrides?.mergeRefreshed !== undefined
        ? { mergeRefreshed: overrides.mergeRefreshed }
        : {}),
      missingError: (name) => new Error(`missing ${name}`),
      refreshFailedError: (name, cause) => new Error(`refresh failed ${name}: ${String(cause)}`),
    });
    return { session, calls };
  }

  test("returns the stored token on the fast path without refreshing", async () => {
    const { session, calls } = makeSession();
    expect(await session.getValidToken("p", 500)).toBe("old");
    expect(calls.refresh).toBe(0);
  });

  test("refreshes an expired token and persists the result", async () => {
    const { session, calls } = makeSession();
    expect(await session.getValidToken("p", 2_000)).toBe("new");
    expect(calls.refresh).toBe(1);
    expect(calls.updates).toHaveLength(1);
  });

  test("treats a token inside the skew window as expired", async () => {
    const { session, calls } = makeSession();
    // expiresAt 1000, skew 100: now=950 is within the window.
    expect(await session.getValidToken("p", 950)).toBe("new");
    expect(calls.refresh).toBe(1);
  });

  test("coalesces concurrent refreshes into one request", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refreshCount = 0;
    const { session } = makeSession({
      refreshTokens: async () => {
        refreshCount += 1;
        await gate;
        return { access: "new", refresh: "ref2", expiresAt: 10_000 };
      },
    });
    const first = session.getValidToken("p", 2_000);
    const second = session.getValidToken("p", 2_000);
    release?.();
    expect(await Promise.all([first, second])).toEqual(["new", "new"]);
    expect(refreshCount).toBe(1);
  });

  test("a failed refresh clears the mutex so the next call can retry", async () => {
    let attempts = 0;
    const { session } = makeSession({
      refreshTokens: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("boom");
        return { access: "new", refresh: "ref2", expiresAt: 10_000 };
      },
    });
    await expect(session.getValidToken("p", 2_000)).rejects.toThrow(/refresh failed p/);
    expect(await session.getValidToken("p", 2_000)).toBe("new");
    expect(attempts).toBe(2);
  });

  test("applies mergeRefreshed so provider fields survive a refresh", async () => {
    const { session, calls } = makeSession({
      profile: { tokens: { access: "old", refresh: "ref", expiresAt: 1_000, accountId: "acct" } },
      mergeRefreshed: (refreshed, previous) => ({
        ...refreshed,
        ...(previous.accountId !== undefined ? { accountId: previous.accountId } : {}),
      }),
    });
    await session.getValidToken("p", 2_000);
    expect(calls.updates[0]?.accountId).toBe("acct");
  });

  test("throws the provider missing error for an unknown profile", async () => {
    const { session } = makeSession();
    // Simulate a store with no such profile.
    const empty = createTokenSession<TestTokens, string>({
      skewMs: 100,
      loadProfile: async () => undefined,
      updateTokens: async () => {},
      refreshTokens: async () => ({ access: "x", refresh: "x", expiresAt: 0 }),
      toAccess: (tokens) => tokens.access,
      missingError: (name) => new Error(`missing ${name}`),
      refreshFailedError: (name) => new Error(`refresh failed ${name}`),
    });
    await expect(empty.getValidToken("nope", 0)).rejects.toThrow("missing nope");
    void session;
  });
});
