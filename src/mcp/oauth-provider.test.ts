import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuthState, saveAuthState } from "./auth-store.js";
import { createOAuthProvider } from "./oauth-provider.js";

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mcp-oauth-"));
}

const clientInfo = (port: number) => ({
  client_id: `client-on-${String(port)}`,
  redirect_uris: [`http://127.0.0.1:${String(port)}/callback`],
  client_id_issued_at: 1,
  token_endpoint_auth_method: "none" as const,
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  client_name: "interchange-code",
});

async function syncValue<T>(value: T | Promise<T>): Promise<T> {
  return await value;
}

describe("createOAuthProvider", () => {
  test("drops stale DCR client when redirect port changed and no tokens exist", async () => {
    const home = await tempHome();
    await saveAuthState(
      "linear",
      {
        clientInformation: clientInfo(60435),
        codeVerifier: "old-verifier",
      },
      home,
    );

    const provider = await createOAuthProvider({
      serverName: "linear",
      redirectUrl: "http://127.0.0.1:62000/callback",
      onAuthURL: () => undefined,
      home,
    });

    expect(await syncValue(provider.clientInformation())).toBeUndefined();
    const disk = await loadAuthState("linear", home);
    expect(disk.clientInformation).toBeUndefined();
    expect(disk.codeVerifier).toBeUndefined();
  });

  test("keeps registered client and tokens when only the loopback port changed", async () => {
    const home = await tempHome();
    await saveAuthState(
      "linear",
      {
        clientInformation: clientInfo(60435),
        tokens: {
          access_token: "live",
          token_type: "bearer",
          expires_in: 3600,
          refresh_token: "refresh",
        },
      },
      home,
    );

    const provider = await createOAuthProvider({
      serverName: "linear",
      redirectUrl: "http://127.0.0.1:62000/callback",
      onAuthURL: () => undefined,
      home,
    });

    expect((await syncValue(provider.clientInformation()))?.client_id).toBe("client-on-60435");
    expect((await syncValue(provider.tokens()))?.access_token).toBe("live");
  });

  test("concurrent saveTokens and saveCodeVerifier from two providers keep both fields", async () => {
    const home = await tempHome();
    await saveAuthState("linear", { clientInformation: clientInfo(1) }, home);

    const a = await createOAuthProvider({
      serverName: "linear",
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
    });
    const b = await createOAuthProvider({
      serverName: "linear",
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
    });

    await Promise.all([
      a.saveTokens({
        access_token: "tok-a",
        token_type: "bearer",
        expires_in: 60,
        refresh_token: "ref-a",
      }),
      b.saveCodeVerifier("verifier-b"),
    ]);

    const disk = await loadAuthState("linear", home);
    expect(disk.tokens?.access_token).toBe("tok-a");
    expect(disk.codeVerifier).toBe("verifier-b");
  });

  test("resetAuthorization clears client when redirect no longer matches registration", async () => {
    const home = await tempHome();
    await saveAuthState(
      "linear",
      {
        clientInformation: clientInfo(60435),
        tokens: {
          access_token: "live",
          token_type: "bearer",
          expires_in: 1,
          refresh_token: "r",
        },
        codeVerifier: "v",
      },
      home,
    );

    const provider = await createOAuthProvider({
      serverName: "linear",
      redirectUrl: "http://127.0.0.1:62000/callback",
      onAuthURL: () => undefined,
      home,
    });

    // Tokens present → client kept at create. Reset simulates failed refresh.
    await provider.resetAuthorization();
    expect(await syncValue(provider.tokens())).toBeUndefined();
    expect(await syncValue(provider.clientInformation())).toBeUndefined();
    const disk = await loadAuthState("linear", home);
    expect(disk.clientInformation).toBeUndefined();
    expect(disk.tokens).toBeUndefined();
  });
});
