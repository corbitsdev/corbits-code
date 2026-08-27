import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

const linear = { serverName: "linear", serverURL: "https://mcp.linear.app/mcp" };

async function syncValue<T>(value: T | Promise<T>): Promise<T> {
  return await value;
}

describe("createOAuthProvider", () => {
  test("drops stale DCR client when redirect port changed and no tokens exist", async () => {
    const home = await tempHome();
    await saveAuthState(
      linear,
      {
        clientInformation: clientInfo(60435),
        codeVerifier: "old-verifier",
      },
      home,
    );

    const provider = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:62000/callback",
      onAuthURL: () => undefined,
      home,
    });

    expect(await syncValue(provider.clientInformation())).toBeUndefined();
    const disk = await loadAuthState(linear, home);
    expect(disk.clientInformation).toBeUndefined();
    expect(disk.codeVerifier).toBeUndefined();
  });

  test("keeps registered client and tokens when only the loopback port changed", async () => {
    const home = await tempHome();
    await saveAuthState(
      linear,
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
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:62000/callback",
      onAuthURL: () => undefined,
      home,
    });

    expect((await syncValue(provider.clientInformation()))?.client_id).toBe("client-on-60435");
    expect((await syncValue(provider.tokens()))?.access_token).toBe("live");
  });

  test("concurrent saveTokens and saveCodeVerifier from two providers keep both fields", async () => {
    const home = await tempHome();
    await saveAuthState(linear, { clientInformation: clientInfo(1) }, home);

    const a = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
    });
    const b = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
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

    const disk = await loadAuthState(linear, home);
    expect(disk.tokens?.access_token).toBe("tok-a");
    expect(disk.codeVerifier).toBe("verifier-b");
  });

  test("resetAuthorization clears client when redirect no longer matches registration", async () => {
    const home = await tempHome();
    await saveAuthState(
      linear,
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
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:62000/callback",
      onAuthURL: () => undefined,
      home,
    });

    // Tokens present → client kept at create. Reset simulates failed refresh.
    await provider.resetAuthorization();
    expect(await syncValue(provider.tokens())).toBeUndefined();
    expect(await syncValue(provider.clientInformation())).toBeUndefined();
    const disk = await loadAuthState(linear, home);
    expect(disk.clientInformation).toBeUndefined();
    expect(disk.tokens).toBeUndefined();
  });

  test("isolates same-name providers by endpoint and persists the same identity", async () => {
    const home = await tempHome();
    const customURL = "https://custom.example/mcp";
    const canonicalURL = "https://mcp.exa.ai/mcp";
    const custom = await createOAuthProvider({
      serverName: "exa",
      serverURL: customURL,
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
    });
    await custom.saveTokens({ access_token: "custom-secret", token_type: "bearer" });

    const canonical = await createOAuthProvider({
      serverName: "exa",
      serverURL: canonicalURL,
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
    });
    const customAgain = await createOAuthProvider({
      serverName: "exa",
      serverURL: customURL,
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
    });

    expect(await syncValue(canonical.tokens())).toBeUndefined();
    expect((await syncValue(customAgain.tokens()))?.access_token).toBe("custom-secret");
  });

  test("leaves ordinary and empty-name legacy state inert", async () => {
    const home = await tempHome();
    const dir = join(home, ".corbits", "mcp-auth");
    await mkdir(dir, { recursive: true });
    const legacy = JSON.stringify({ tokens: { access_token: "legacy" } });
    await writeFile(join(dir, "exa.json"), legacy);
    await writeFile(join(dir, ".json"), legacy);

    const exa = await createOAuthProvider({
      serverName: "exa",
      serverURL: "https://mcp.exa.ai/mcp",
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
    });
    const emptyName = await createOAuthProvider({
      serverName: "",
      serverURL: "https://empty.example/mcp",
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
    });

    expect(await syncValue(exa.tokens())).toBeUndefined();
    expect(await syncValue(emptyName.tokens())).toBeUndefined();
    expect(await readFile(join(dir, "exa.json"), "utf8")).toBe(legacy);
    expect(await readFile(join(dir, ".json"), "utf8")).toBe(legacy);
  });

  test("does not delete scoped state whose filename stem is another provider name", async () => {
    const home = await tempHome();
    const dir = join(home, ".corbits", "mcp-auth");
    const existingIdentity = { serverName: "exa", serverURL: "https://custom.example/mcp" };
    await saveAuthState(
      existingIdentity,
      { tokens: { access_token: "scoped-secret", token_type: "bearer" } },
      home,
    );
    const [scopedFilename] = await Array.fromAsync(new Bun.Glob("exa-*.json").scan(dir));
    expect(scopedFilename).toBeDefined();
    const collidingName = scopedFilename?.slice(0, -".json".length) ?? "missing";

    const collidingProvider = await createOAuthProvider({
      serverName: collidingName,
      serverURL: "https://other.example/mcp",
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
    });
    const existingProvider = await createOAuthProvider({
      ...existingIdentity,
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
    });

    expect(await syncValue(collidingProvider.tokens())).toBeUndefined();
    expect((await syncValue(existingProvider.tokens()))?.access_token).toBe("scoped-secret");
    expect((await loadAuthState(existingIdentity, home)).tokens?.access_token).toBe(
      "scoped-secret",
    );
  });
});
