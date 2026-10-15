import { describe, expect, test } from "bun:test";
import { createProviderTokenSession } from "./provider-token-session.js";

type TestTokens = {
  access: string;
  refresh: string;
  expiresAt: number;
};

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

describe("createProviderTokenSession", () => {
  test("staged refresh hands the prior tokens to the provider hook", async () => {
    const seen: {
      refreshToken: string;
      previousAccess: string | undefined;
    }[] = [];
    const api = createProviderTokenSession<TestTokens, { access: string }>({
      errorClass: TestAuthError,
      providerLabel: "Test",
      skewMs: 0,
      loadProfile: async () => undefined,
      updateTokens: async () => undefined,
      toAccess: (tokens) => ({ access: tokens.access }),
      refreshTokens: async (refreshToken, now, previous) => {
        seen.push({ refreshToken, previousAccess: previous?.access });
        return { access: "fresh", refresh: "r2", expiresAt: now + 10_000 };
      },
    });

    expect(
      await api.refreshStaged(
        { access: "old2", refresh: "r1", expiresAt: 1_000 },
        5_000,
      ),
    ).toEqual({ access: "fresh", refresh: "r2", expiresAt: 15_000 });
    expect(seen).toEqual([{ refreshToken: "r1", previousAccess: "old2" }]);
  });
});
