import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  loadCodexProfile,
  saveCodexProfile,
} from "../../config/oauth-stores.js";
import { createCodexTokenSession } from "./session.js";

// Two concurrent headless runs share one Codex credential: two independent
// token sessions over the same home directory, as if in two processes. The
// stubbed token endpoint rotates the refresh token on every grant, like the
// real one: a grant presenting a superseded refresh token is rejected with
// invalid_grant. Both callers must resolve with the rotated access token and
// the endpoint must see a single grant.
describe("codex shared-credential refresh race", () => {
  test("a concurrent winner without accountId replaces the loser exactly", async () => {
    const home = await mkdtemp(join(tmpdir(), "cl9347-codex-winner-"));
    const now = Date.now();
    await saveCodexProfile(
      {
        name: "shared",
        createdAt: now,
        tokens: {
          access: "access-old",
          refresh: "refresh-old",
          expiresAt: now - 300_000,
          accountId: "old-account",
        },
      },
      home,
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      await saveCodexProfile(
        {
          name: "shared",
          createdAt: now,
          tokens: {
            access: "access-winner",
            refresh: "refresh-winner",
            expiresAt: now + 3_600_000,
          },
        },
        home,
      );
      return Response.json({
        access_token: "access-loser",
        refresh_token: "refresh-loser",
        expires_in: 3600,
      });
    }) as unknown as typeof fetch;

    try {
      const access = await createCodexTokenSession(home).getValidToken(
        "shared",
        now,
      );
      expect(access).toEqual({ access: "access-winner" });
      expect(await loadCodexProfile("shared", home)).toEqual({
        name: "shared",
        createdAt: now,
        tokens: {
          access: "access-winner",
          refresh: "refresh-winner",
          expiresAt: now + 3_600_000,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("concurrent refreshes on one shared store both resolve with one grant", async () => {
    const home = await mkdtemp(join(tmpdir(), "cl8628-race-"));
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
    let grants = 0;
    let arrivals = 0;
    let liveRefresh = "refresh-1";
    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
      const target = String(input);
      if (!target.includes("/oauth/token"))
        throw new Error(`unexpected token fetch: ${target}`);
      grants += 1;
      arrivals += 1;
      if (arrivals === 1) {
        // Rendezvous: hold the first grant until the second refresh arrives
        // (or a timeout), forcing the two refreshes to overlap the way two
        // concurrent headless runs do.
        const start = Date.now();
        while (arrivals < 2 && Date.now() - start < 1_000)
          await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const presented = new URLSearchParams(String(init?.body ?? "")).get(
        "refresh_token",
      );
      if (presented !== liveRefresh) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        });
      }
      liveRefresh = "refresh-2";
      return Response.json({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 3600,
      });
    }) as unknown as typeof fetch;

    try {
      const first = createCodexTokenSession(home);
      const second = createCodexTokenSession(home);
      const [a, b] = await Promise.all([
        first.getValidToken("shared", now),
        second.getValidToken("shared", now),
      ]);
      expect(a.access).toBe("access-2");
      expect(b.access).toBe("access-2");
      expect(grants).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(home, { recursive: true, force: true });
    }
  });
});
