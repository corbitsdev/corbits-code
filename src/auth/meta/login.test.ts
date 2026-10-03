import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMetaLogin } from "./login.js";
import { loadMetaProfile } from "../../config/oauth-stores.js";

const AUTH_URL = "https://auth.meta.com/oidc/device/authorization/";
const TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
const MINT_URL = "https://api.meta.ai/muse-code/key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function noopSleep(): Promise<void> {
  return Promise.resolve();
}

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "meta-login-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("startMetaLogin (device flow)", () => {
  test("authorize → poll pending → complete → mint → saved profile", async () => {
    await withHome(async (home) => {
      const requests: string[] = [];
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url === AUTH_URL) {
          return jsonResponse({
            device_code: "dc-1",
            user_code: "ABCD-1234",
            verification_uri_complete:
              "https://auth.meta.com/device?code=ABCD-1234",
            interval: 1,
            expires_in: 1800,
          });
        }
        if (url === TOKEN_URL) {
          return jsonResponse({
            access_token: "identity-token",
            token_type: "bearer",
          });
        }
        if (url === MINT_URL) {
          return jsonResponse({ api_key: "LLM|minted" });
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as unknown as typeof fetch;

      let notified: { verificationUri: string; userCode: string } | undefined;
      const controller = new AbortController();
      const handle = startMetaLogin({
        profile: "work",
        signal: controller.signal,
        home,
        fetchImpl,
        sleep: noopSleep,
        notify: (event) => {
          notified = {
            verificationUri: event.verificationUri,
            userCode: event.userCode,
          };
        },
      });

      const staged = await handle.completed;
      expect(notified).toEqual({
        verificationUri: "https://auth.meta.com/device?code=ABCD-1234",
        userCode: "ABCD-1234",
      });
      expect(staged.profile.name).toBe("work");
      expect(staged.profile.tokens.access).toBe("LLM|minted");
      expect(staged.profile.tokens.refresh).toBe("identity-token");

      await staged.commit();
      const saved = await loadMetaProfile("work", home);
      expect(saved?.tokens.access).toBe("LLM|minted");
      expect(saved?.tokens.refresh).toBe("identity-token");
      expect(requests).toEqual([AUTH_URL, TOKEN_URL, MINT_URL]);
    });
  });

  test("abort rejects with the cancelled-login message", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === AUTH_URL) {
        return jsonResponse({
          device_code: "dc-1",
          user_code: "ABCD-1234",
          verification_uri_complete: "https://auth.meta.com/device",
          interval: 1,
          expires_in: 1800,
        });
      }
      // Token poll parks until the caller aborts, then rejects like real fetch.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    const handle = startMetaLogin({
      profile: "work",
      signal: controller.signal,
      fetchImpl,
      sleep: noopSleep,
    });

    const pending = handle.completed.catch((err: unknown) => err);
    setTimeout(() => controller.abort(), 0);
    const err = await pending;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Login cancelled");
  });
});
