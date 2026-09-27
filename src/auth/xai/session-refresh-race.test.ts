import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { errorMessage } from "../../agent/error-message.js";
import { loadXaiProfile, saveXaiProfile } from "../../config/oauth-stores.js";
import { formatSubAgentSpawnAuthFailureMessage } from "../../subagent/inference-auth-failure.js";
import {
  createXaiTokenSession,
  getValidXaiToken,
  XaiAuthError,
} from "./session.js";

async function saveExpiredProfile(home: string, now: number): Promise<void> {
  await saveXaiProfile(
    {
      name: "shared",
      createdAt: now,
      tokens: {
        access: "access-1",
        refresh: "refresh-1",
        expiresAt: now - 300_000,
      },
    },
    home,
  );
}

describe("xAI shared-credential refresh race", () => {
  test("a concurrent winner replaces every optional loser field", async () => {
    const home = await mkdtemp(join(tmpdir(), "cl9347-xai-winner-"));
    const now = Date.now();
    await saveXaiProfile(
      {
        name: "shared",
        createdAt: now,
        tokens: {
          access: "access-old",
          refresh: "refresh-old",
          expiresAt: now - 300_000,
          idToken: "id-old",
        },
      },
      home,
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      await saveXaiProfile(
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
        id_token: "id-loser",
      });
    }) as unknown as typeof fetch;

    try {
      expect(
        await createXaiTokenSession(home).getValidToken("shared", now),
      ).toEqual({ access: "access-winner" });
      expect(await loadXaiProfile("shared", home)).toEqual({
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

  test("independent sessions return the committed rotated winner", async () => {
    const home = await mkdtemp(join(tmpdir(), "cl9347-xai-race-"));
    const now = Date.now();
    await saveExpiredProfile(home, now);
    const originalFetch = globalThis.fetch;
    let grants = 0;
    let resolveSecond!: () => void;
    const secondArrived = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    globalThis.fetch = (async () => {
      grants += 1;
      if (grants === 1) {
        await secondArrived;
        return Response.json({
          access_token: "access-2",
          refresh_token: "refresh-2",
          expires_in: 3600,
        });
      }
      resolveSecond();
      while (
        (await loadXaiProfile("shared", home))?.tokens.refresh !== "refresh-2"
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      });
    }) as unknown as typeof fetch;

    try {
      const first = createXaiTokenSession(home);
      const second = createXaiTokenSession(home);
      expect(
        await Promise.all([
          first.getValidToken("shared", now),
          second.getValidToken("shared", now),
        ]),
      ).toEqual([{ access: "access-2" }, { access: "access-2" }]);
      expect(grants).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("invalid_grant without a newer winner remains actionable", async () => {
    const home = await mkdtemp(join(tmpdir(), "cl9347-xai-invalid-"));
    const now = Date.now();
    await saveExpiredProfile(home, now);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      })) as unknown as typeof fetch;
    try {
      await expect(getValidXaiToken("shared", now, home)).rejects.toMatchObject(
        {
          name: "XaiAuthError",
          reason: "refresh-failed",
          message: expect.stringContaining("Log in again"),
        } satisfies Partial<XaiAuthError>,
      );
    } finally {
      globalThis.fetch = originalFetch;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a token endpoint cannot reflect the stored refresh credential", async () => {
    const home = await mkdtemp(join(tmpdir(), "cl9347-xai-redact-"));
    const now = Date.now();
    const refresh = "opaque refresh value / with spaces?!";
    await saveXaiProfile(
      {
        name: "shared",
        createdAt: now,
        tokens: {
          access: "access-1",
          refresh,
          expiresAt: now - 300_000,
        },
      },
      home,
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(`grant rejected for ${refresh}`, {
        status: 400,
      })) as unknown as typeof fetch;
    try {
      const failure = await getValidXaiToken("shared", now, home).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(XaiAuthError);
      const auth = failure as XaiAuthError;
      const surfaced = JSON.stringify({
        auth: String(auth),
        retry: {
          type: "inference.retry",
          data: { previousError: { message: auth.message } },
        },
        terminal: {
          type: "inference.error",
          data: { error: { message: auth.message } },
        },
        log: errorMessage(auth),
        guidance: formatSubAgentSpawnAuthFailureMessage("auth task", auth),
      });
      expect(surfaced).not.toContain(refresh);
      expect(surfaced).toContain("grant rejected");
      expect(surfaced).toContain("Re-authenticate");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(home, { recursive: true, force: true });
    }
  });
});
