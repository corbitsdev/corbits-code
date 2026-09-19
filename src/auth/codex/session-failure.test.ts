import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { saveCodexProfile } from "../../config/oauth-stores.js";
import {
  codexAuthFailureDiagnostic,
  CodexAuthError,
  getValidCodexToken,
} from "./session.js";

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cl8628-failure-"));
}

describe("codex auth failure surface", () => {
  test("a missing profile rejects with a re-login hint, never a bare not-found", async () => {
    const home = await tempHome();
    try {
      let failure: unknown;
      try {
        await getValidCodexToken("ghost", Date.now(), home);
      } catch (err) {
        failure = err;
      }
      expect(failure).toBeInstanceOf(CodexAuthError);
      const auth = failure as CodexAuthError;
      expect(auth.reason).toBe("missing");
      expect(auth.message).toContain('"ghost"');
      expect(auth.message).toContain("Log in again");
      expect(auth.message).not.toContain("No OAuth profile named");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a rejected refresh rejects with a re-login hint", async () => {
    const home = await tempHome();
    const now = Date.now();
    await saveCodexProfile(
      {
        name: "shared",
        createdAt: now,
        tokens: {
          access: "access-1",
          refresh: "refresh-1",
          expiresAt: now - 300_000,
          accountId: "acct-1",
        },
      },
      home,
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      })) as unknown as typeof fetch;
    try {
      let failure: unknown;
      try {
        await getValidCodexToken("shared", now, home);
      } catch (err) {
        failure = err;
      }
      expect(failure).toBeInstanceOf(CodexAuthError);
      expect((failure as CodexAuthError).reason).toBe("refresh-failed");
      expect((failure as CodexAuthError).message).toContain("Log in again");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("fresh tokens resolve without touching the network", async () => {
    const home = await tempHome();
    const now = Date.now();
    await saveCodexProfile(
      {
        name: "shared",
        createdAt: now,
        tokens: {
          access: "access-1",
          refresh: "refresh-1",
          expiresAt: now + 3_600_000,
          accountId: "acct-1",
        },
      },
      home,
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network must not be touched for fresh tokens");
    }) as unknown as typeof fetch;
    try {
      const access = await getValidCodexToken("shared", now, home);
      expect(access.access).toBe("access-1");
      expect(access.accountId).toBe("acct-1");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("codexAuthFailureDiagnostic projects auth errors onto credential_failure", () => {
    const auth = new CodexAuthError(
      "personal",
      "refresh-failed",
      'Codex profile "personal" could not be refreshed (boom). Log in again.',
    );
    expect(codexAuthFailureDiagnostic(auth)).toEqual({
      category: "credential_failure",
      message: auth.message,
    });
    expect(codexAuthFailureDiagnostic(new Error("boom"))).toBeNull();
    expect(codexAuthFailureDiagnostic("boom")).toBeNull();
  });
});
