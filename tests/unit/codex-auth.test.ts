import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { generatePkce, generateState } from "../../src/adapters/auth/codex/pkce.js";
import { accountIdFromIdToken, buildAuthorizeUrl, tokensFromResponse } from "../../src/adapters/auth/codex/oauth.js";
import {
  listCodexProfiles,
  loadCodexProfile,
  removeCodexProfile,
  saveCodexProfile,
  updateCodexTokens,
  type CodexProfile,
} from "../../src/adapters/auth/codex/store.js";
import { CODEX_CLIENT_ID, CODEX_REDIRECT_URI } from "../../src/adapters/auth/codex/constants.js";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("PKCE generation", () => {
  test("verifier and challenge are base64url with no padding", () => {
    const pkce = generatePkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.method).toBe("S256");
  });

  test("challenge is the S256 digest of the verifier", () => {
    const pkce = generatePkce();
    const expected = base64url(createHash("sha256").update(pkce.verifier).digest());
    expect(pkce.challenge).toBe(expected);
  });

  test("each call produces a distinct verifier and state", () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
    expect(generateState()).not.toBe(generateState());
  });
});

describe("buildAuthorizeUrl", () => {
  test("carries client id, redirect, PKCE challenge, state, and Codex params", () => {
    const pkce = generatePkce();
    const state = generateState();
    const url = new URL(buildAuthorizeUrl(pkce, state));
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CODEX_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(CODEX_REDIRECT_URI);
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("originator")).toBe("codex_cli_rs");
  });
});

describe("tokensFromResponse", () => {
  test("computes absolute expiry from expires_in seconds", () => {
    const now = 1_000_000;
    const tokens = tokensFromResponse(
      { access_token: "a", refresh_token: "r", expires_in: 3600 },
      now,
    );
    expect(tokens.access).toBe("a");
    expect(tokens.refresh).toBe("r");
    expect(tokens.expiresAt).toBe(now + 3600 * 1000);
  });

  test("carries previous refresh token forward when response omits one", () => {
    const tokens = tokensFromResponse({ access_token: "a", expires_in: 60 }, 0, "old-refresh");
    expect(tokens.refresh).toBe("old-refresh");
  });

  test("throws when no refresh token is available anywhere", () => {
    expect(() => tokensFromResponse({ access_token: "a" }, 0)).toThrow(/refresh_token/);
  });

  test("falls back to a default lifetime when expires_in is absent", () => {
    const tokens = tokensFromResponse({ access_token: "a", refresh_token: "r" }, 0);
    expect(tokens.expiresAt).toBeGreaterThan(0);
  });

  test("extracts accountId from a JWT id_token", () => {
    const jwt = makeIdToken({ chatgpt_account_id: "acct-123" });
    const tokens = tokensFromResponse({ access_token: "a", refresh_token: "r", id_token: jwt }, 0);
    expect(tokens.accountId).toBe("acct-123");
  });

  test("omits accountId when the id_token is absent", () => {
    const tokens = tokensFromResponse({ access_token: "a", refresh_token: "r" }, 0);
    expect(tokens.accountId).toBeUndefined();
  });
});

function makeIdToken(claims: Record<string, unknown>): string {
  const segment = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  return `${segment({ alg: "none" })}.${segment(claims)}.sig`;
}

describe("accountIdFromIdToken", () => {
  test("reads the top-level chatgpt_account_id claim", () => {
    expect(accountIdFromIdToken(makeIdToken({ chatgpt_account_id: "top" }))).toBe("top");
  });

  test("falls back to the nested OpenAI auth claim", () => {
    const jwt = makeIdToken({ "https://api.openai.com/auth": { chatgpt_account_id: "nested" } });
    expect(accountIdFromIdToken(jwt)).toBe("nested");
  });

  test("returns undefined for a missing or malformed token", () => {
    expect(accountIdFromIdToken(undefined)).toBeUndefined();
    expect(accountIdFromIdToken("not-a-jwt")).toBeUndefined();
    expect(accountIdFromIdToken(makeIdToken({ sub: "x" }))).toBeUndefined();
  });
});

describe("Codex profile store", () => {
  async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = await mkdtemp(join(tmpdir(), "codex-store-"));
    try {
      return await fn(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  function profile(name: string): CodexProfile {
    return {
      name,
      createdAt: 123,
      tokens: { access: `access-${name}`, refresh: `refresh-${name}`, expiresAt: 999 },
    };
  }

  test("returns no profiles for a fresh home", async () => {
    await withHome(async (home) => {
      expect(await listCodexProfiles(home)).toEqual([]);
      expect(await loadCodexProfile("missing", home)).toBeUndefined();
    });
  });

  test("saves and loads multiple named profiles independently", async () => {
    await withHome(async (home) => {
      await saveCodexProfile(profile("personal"), home);
      await saveCodexProfile(profile("work"), home);
      const all = await listCodexProfiles(home);
      expect(all.map((p) => p.name)).toEqual(["personal", "work"]);
      const work = await loadCodexProfile("work", home);
      expect(work?.tokens.access).toBe("access-work");
      const personal = await loadCodexProfile("personal", home);
      expect(personal?.tokens.refresh).toBe("refresh-personal");
    });
  });

  test("updateCodexTokens preserves createdAt and only touches the named profile", async () => {
    await withHome(async (home) => {
      await saveCodexProfile(profile("personal"), home);
      await saveCodexProfile(profile("work"), home);
      await updateCodexTokens("work", { access: "new", refresh: "new-r", expiresAt: 5000 }, home);
      const work = await loadCodexProfile("work", home);
      expect(work?.tokens.access).toBe("new");
      expect(work?.createdAt).toBe(123);
      const personal = await loadCodexProfile("personal", home);
      expect(personal?.tokens.access).toBe("access-personal");
    });
  });

  test("updateCodexTokens is a no-op for an unknown profile", async () => {
    await withHome(async (home) => {
      await updateCodexTokens("ghost", { access: "x", refresh: "y", expiresAt: 1 }, home);
      expect(await loadCodexProfile("ghost", home)).toBeUndefined();
    });
  });

  test("removeCodexProfile removes one profile and reports it", async () => {
    await withHome(async (home) => {
      await saveCodexProfile(profile("personal"), home);
      await saveCodexProfile(profile("work"), home);
      expect(await removeCodexProfile("work", home)).toEqual(["work"]);
      expect((await listCodexProfiles(home)).map((p) => p.name)).toEqual(["personal"]);
    });
  });

  test("removeCodexProfile with no name clears all profiles", async () => {
    await withHome(async (home) => {
      await saveCodexProfile(profile("personal"), home);
      await saveCodexProfile(profile("work"), home);
      const removed = await removeCodexProfile(undefined, home);
      expect(removed.sort()).toEqual(["personal", "work"]);
      expect(await listCodexProfiles(home)).toEqual([]);
    });
  });

  test("removing a missing profile reports nothing removed", async () => {
    await withHome(async (home) => {
      expect(await removeCodexProfile("nope", home)).toEqual([]);
    });
  });
});
