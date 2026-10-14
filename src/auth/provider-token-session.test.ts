import { describe, expect, test } from "bun:test";
import { createProviderTokenSession } from "./provider-token-session.js";

type TestTokens = {
  access: string;
  refresh: string;
  expiresAt: number;
};

type TestAccess = { access: string };

class TestAuthError extends Error {
  readonly profile: string;
  readonly reason: "missing" | "refresh-failed";

  constructor(
    profile: string,
    reason: "missing" | "refresh-failed",
    message: string,
  ) {
    super(message);
    this.name = "TestAuthError";
    this.profile = profile;
    this.reason = reason;
  }
}

type Profile = { name: string; createdAt: number; tokens: TestTokens };

function buildSpec(overrides?: {
  refreshOutcome?: TestTokens | Error;
  mergeRefreshed?: boolean;
}) {
  // One in-memory profile store behind the same shape the disk store has,
  // including the expectedRefreshToken CAS the session feeds it.
  const store = new Map<string, Profile>([
    [
      "p",
      {
        name: "p",
        createdAt: 0,
        tokens: { access: "old", refresh: "r1", expiresAt: 1_000 },
      },
    ],
  ]);
  const refreshCalls: {
    refreshToken: string;
    now: number;
    previousAccess: string | undefined;
    previousRefresh: string | undefined;
  }[] = [];
  const spec = {
    errorClass: TestAuthError,
    providerLabel: "Test",
    skewMs: 0,
    loadProfile: async (name: string) => store.get(name),
    updateTokens: async (
      name: string,
      tokens: TestTokens,
      home: string | undefined,
      expectedRefreshToken: string | undefined,
    ) => {
      if (name !== "p" || home !== undefined) return undefined;
      const existing = store.get("p");
      if (existing === undefined) return undefined;
      if (
        expectedRefreshToken !== undefined &&
        existing.tokens.refresh !== expectedRefreshToken
      )
        return existing;
      const updated = { ...existing, tokens };
      store.set("p", updated);
      return updated;
    },
    toAccess: (tokens: TestTokens) => ({ access: tokens.access }),
    refreshTokens: async (
      refreshToken: string,
      now: number,
      previous?: TestTokens,
    ) => {
      // Capture the staged prior tokens at call time: replaceMutableTokens
      // mutates the passed object in place after this hook returns.
      refreshCalls.push({
        refreshToken,
        now,
        previousAccess: previous?.access,
        previousRefresh: previous?.refresh,
      });
      const outcome = overrides?.refreshOutcome;
      if (outcome instanceof Error) throw outcome;
      return (
        outcome ?? { access: "fresh", refresh: "r2", expiresAt: now + 10_000 }
      );
    },
  };
  const api = createProviderTokenSession<TestTokens, TestAccess>({
    ...spec,
    ...(overrides?.mergeRefreshed
      ? {
          mergeRefreshed: (refreshed: TestTokens, previous: TestTokens) => ({
            ...refreshed,
            access: `${refreshed.access}+${previous.refresh}`,
          }),
        }
      : {}),
  });
  return { api, store, refreshCalls };
}

describe("createProviderTokenSession", () => {
  test("refreshes an expired profile through the provider spec", async () => {
    const { api, store } = buildSpec();
    expect(await api.getValidToken("p", 5_000)).toEqual({ access: "fresh" });
    expect(store.get("p")?.tokens).toEqual({
      access: "fresh",
      refresh: "r2",
      expiresAt: 15_000,
    });
    expect(store.get("p")?.createdAt).toBe(0);
  });

  test("a concurrent store winner is never clobbered by the CAS basis", async () => {
    // Another session rotates the store to refresh "r3" while this one's
    // grant (presented r1) is in flight: the loser observes the committed
    // winner instead of overwriting it.
    const { api, store } = buildSpec();
    const first = api.getValidToken("p", 5_000);
    store.set("p", {
      name: "p",
      createdAt: 0,
      tokens: { access: "winner", refresh: "r3", expiresAt: 15_000 },
    });
    expect(await first).toEqual({ access: "winner" });
    expect(store.get("p")?.tokens.access).toBe("winner");
  });

  test("the per-provider merge hook runs before the store write", async () => {
    const { api, store } = buildSpec({
      mergeRefreshed: true,
      refreshOutcome: { access: "fresh", refresh: "r2", expiresAt: 15_000 },
    });
    await api.getValidToken("p", 5_000);
    expect(store.get("p")?.tokens).toEqual({
      access: "fresh+r1",
      refresh: "r2",
      expiresAt: 15_000,
    });
  });

  test("staged refresh hands the prior tokens to the provider hook", async () => {
    const { api, refreshCalls } = buildSpec();
    expect(
      await api.refreshStaged(
        { access: "old2", refresh: "r1", expiresAt: 1_000 },
        5_000,
      ),
    ).toEqual({ access: "fresh", refresh: "r2", expiresAt: 15_000 });
    expect(refreshCalls.length).toBe(1);
    expect(refreshCalls[0]?.refreshToken).toBe("r1");
    expect(refreshCalls[0]?.previousAccess).toBe("old2");
  });

  test("wraps core failures into the provider error with its label", async () => {
    const { api } = buildSpec();
    const missing = await api
      .getValidToken("ghost", 5_000)
      .catch((err: unknown) => err);
    expect(missing).toBeInstanceOf(TestAuthError);
    expect(missing).toMatchObject({ profile: "ghost", reason: "missing" });
    expect((missing as TestAuthError).message).toContain(
      'Test profile "ghost" is not authorized. Log in again.',
    );

    const refreshFailed = await buildSpec({
      refreshOutcome: new Error("grant rejected"),
    })
      .api.getValidToken("p", 5_000)
      .catch((err: unknown) => err);
    expect(refreshFailed).toBeInstanceOf(TestAuthError);
    expect(refreshFailed).toMatchObject({
      profile: "p",
      reason: "refresh-failed",
    });
    expect((refreshFailed as TestAuthError).message).toContain(
      'Test profile "p" could not be refreshed (grant rejected). Log in again.',
    );
  });

  test("absent serializeRefresh hook exposes the inner session unwrapped", async () => {
    // The blocker contract: absent hook = no lock, no wrapping at all.
    const { api } = buildSpec();
    const session = api.createSession();
    expect(Object.keys(session).sort()).toEqual(["getValidToken", "isExpired"]);
  });

  test("stale tokens within the skew read as expired", async () => {
    const { api } = buildSpec();
    expect(
      api.isExpired({ access: "a", refresh: "r", expiresAt: 5_000 }, 5_000),
    ).toBe(true);
    expect(
      api.isExpired({ access: "a", refresh: "r", expiresAt: 6_000 }, 5_000),
    ).toBe(false);
  });
});
