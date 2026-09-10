import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { authFilePath, loadAuthState, saveAuthState, deleteAuthState } from "./auth-store.js";
import { fetchWithConnectAbort } from "./client.js";
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

async function saveClient(
  provider: Awaited<ReturnType<typeof createOAuthProvider>>,
  info: ReturnType<typeof clientInfo>,
): Promise<void> {
  const save = provider.saveClientInformation;
  if (save === undefined) throw new Error("saveClientInformation is required");
  await save(info);
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

  test("propagates tokens saved by one provider to an existing sibling provider", async () => {
    const home = await tempHome();
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
    expect(await syncValue(b.tokens())).toBeUndefined();

    await a.saveTokens({
      access_token: "fresh",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "fresh-refresh",
    });

    expect((await syncValue(b.tokens()))?.access_token).toBe("fresh");
  });

  test("does not replace an in-progress PKCE verifier from a different-port sibling", async () => {
    const home = await tempHome();
    const a = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:62000/callback",
      onAuthURL: () => undefined,
      home,
    });
    await saveClient(a, clientInfo(62000));
    await a.saveCodeVerifier("pkce-a");

    const b = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:60435/callback",
      onAuthURL: () => undefined,
      home,
    });
    expect(a.codeVerifier()).toBe("pkce-a");

    await b.saveCodeVerifier("pkce-b");
    expect(a.codeVerifier()).toBe("pkce-a");
    expect(b.codeVerifier()).toBe("pkce-b");
  });

  test("does not adopt a different-port sibling DCR client without tokens", async () => {
    const home = await tempHome();
    const a = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:62000/callback",
      onAuthURL: () => undefined,
      home,
    });
    await saveClient(a, clientInfo(62000));

    const b = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:60435/callback",
      onAuthURL: () => undefined,
      home,
    });
    expect((await syncValue(a.clientInformation()))?.client_id).toBe("client-on-62000");

    await saveClient(b, clientInfo(60435));
    const info = await syncValue(a.clientInformation());
    expect(info?.client_id).toBe("client-on-62000");
    expect(info && "redirect_uris" in info ? info.redirect_uris : undefined).toEqual([
      "http://127.0.0.1:62000/callback",
    ]);
  });

  test("saveTokens after a different-port sibling construct keeps this session's DCR", async () => {
    const home = await tempHome();
    const a = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:62000/callback",
      onAuthURL: () => undefined,
      home,
    });
    await saveClient(a, clientInfo(62000));
    await a.saveCodeVerifier("pkce-a");

    const b = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:60435/callback",
      onAuthURL: () => undefined,
      home,
    });
    expect(await syncValue(b.clientInformation())).toBeUndefined();

    await a.saveTokens({
      access_token: "tok-a",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "ref-a",
    });

    const info = await syncValue(a.clientInformation());
    expect(info?.client_id).toBe("client-on-62000");
    expect(info && "redirect_uris" in info ? info.redirect_uris : undefined).toEqual([
      "http://127.0.0.1:62000/callback",
    ]);
    const disk = await loadAuthState(linear, home);
    expect(disk.clientInformation?.client_id).toBe("client-on-62000");
    expect(disk.clientInformation?.redirect_uris).toEqual(["http://127.0.0.1:62000/callback"]);
  });

  test("saveTokens after a different-port sibling saveClient keeps this session's DCR", async () => {
    const home = await tempHome();
    const a = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:62000/callback",
      onAuthURL: () => undefined,
      home,
    });
    await saveClient(a, clientInfo(62000));
    await a.saveCodeVerifier("pkce-a");

    const b = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:60435/callback",
      onAuthURL: () => undefined,
      home,
    });
    await saveClient(b, clientInfo(60435));

    await a.saveTokens({
      access_token: "tok-a",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "ref-a",
    });

    const info = await syncValue(a.clientInformation());
    expect(info?.client_id).toBe("client-on-62000");
    expect(info && "redirect_uris" in info ? info.redirect_uris : undefined).toEqual([
      "http://127.0.0.1:62000/callback",
    ]);
    const disk = await loadAuthState(linear, home);
    expect(disk.clientInformation?.client_id).toBe("client-on-62000");
    expect(disk.clientInformation?.redirect_uris).toEqual(["http://127.0.0.1:62000/callback"]);
    expect(disk.tokens?.access_token).toBe("tok-a");
    expect((await syncValue(a.tokens()))?.access_token).toBe("tok-a");
  });

  test("saveCodeVerifier after a different-port sibling saveClient does not adopt that client", async () => {
    const home = await tempHome();
    const a = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:62000/callback",
      onAuthURL: () => undefined,
      home,
    });
    await saveClient(a, clientInfo(62000));

    const b = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:60435/callback",
      onAuthURL: () => undefined,
      home,
    });
    await saveClient(b, clientInfo(60435));
    await a.saveCodeVerifier("pkce-a");

    const info = await syncValue(a.clientInformation());
    expect(info?.client_id).toBe("client-on-62000");
    expect(info && "redirect_uris" in info ? info.redirect_uris : undefined).toEqual([
      "http://127.0.0.1:62000/callback",
    ]);
  });

  test("idle tokens getter adopts a sibling's completed auth without rewriting matching DCR", async () => {
    const home = await tempHome();
    const a = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:62000/callback",
      onAuthURL: () => undefined,
      home,
    });
    await saveClient(a, clientInfo(62000));
    await a.saveTokens({
      access_token: "tok-a",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "ref-a",
    });

    const b = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:60435/callback",
      onAuthURL: () => undefined,
      home,
    });
    await saveClient(b, clientInfo(60435));
    await b.saveTokens({
      access_token: "tok-b",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "ref-b",
    });

    expect((await syncValue(a.tokens()))?.access_token).toBe("tok-b");
    const disk = await loadAuthState(linear, home);
    expect(disk.tokens?.access_token).toBe("tok-b");
    expect(disk.clientInformation?.client_id).toBe("client-on-60435");
    expect(disk.clientInformation?.redirect_uris).toEqual(["http://127.0.0.1:60435/callback"]);
  });

  test("same-port DCR rotation after a different-port sibling saveClient keeps the new client", async () => {
    const home = await tempHome();
    const v1 = { ...clientInfo(62000), client_id: "client-on-62000-v1" };
    const v2 = { ...clientInfo(62000), client_id: "client-on-62000-v2" };
    const a = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:62000/callback",
      onAuthURL: () => undefined,
      home,
    });
    await saveClient(a, v1);

    const b = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:60435/callback",
      onAuthURL: () => undefined,
      home,
    });
    await saveClient(b, clientInfo(60435));
    await saveClient(a, v2);

    const info = await syncValue(a.clientInformation());
    expect(info?.client_id).toBe("client-on-62000-v2");
    expect(info && "redirect_uris" in info ? info.redirect_uris : undefined).toEqual([
      "http://127.0.0.1:62000/callback",
    ]);
    const disk = await loadAuthState(linear, home);
    expect(disk.clientInformation?.client_id).toBe("client-on-62000-v2");
    expect(disk.clientInformation?.redirect_uris).toEqual(["http://127.0.0.1:62000/callback"]);
  });

  test("sync getters fall back to the in-memory mirror when the auth file disappears", async () => {
    const home = await tempHome();
    const provider = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
    });
    await provider.saveTokens({ access_token: "tok", token_type: "bearer" });
    expect((await syncValue(provider.tokens()))?.access_token).toBe("tok");

    await deleteAuthState(linear, home);

    expect((await syncValue(provider.tokens()))?.access_token).toBe("tok");
    expect(await syncValue(provider.clientInformation())).toBeUndefined();
  });

  test("keeps live tokens when the auth file is corrupt", async () => {
    const home = await tempHome();
    const provider = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
    });
    await provider.saveTokens({ access_token: "tok", token_type: "bearer" });

    const path = authFilePath(linear, home);
    await writeFile(path, "{not-json");
    expect((await syncValue(provider.tokens()))?.access_token).toBe("tok");
  });

  test("keeps the mirror through an unreadable auth file and recovers once readable", async () => {
    const home = await tempHome();
    const provider = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
    });
    await provider.saveTokens({ access_token: "tok", token_type: "bearer" });

    const path = authFilePath(linear, home);
    await chmod(path, 0o000);
    try {
      try {
        readFileSync(path, "utf8");
        // Owner-read still succeeds (root or platforms that ignore mode) — skip.
        return;
      } catch (err) {
        expect(
          typeof err === "object" &&
            err !== null &&
            "code" in err &&
            (err as { code?: unknown }).code === "EACCES",
        ).toBe(true);
      }
      expect((await syncValue(provider.tokens()))?.access_token).toBe("tok");
      expect((await syncValue(provider.tokens()))?.access_token).toBe("tok");
    } finally {
      await chmod(path, 0o600);
    }
    await saveAuthState(linear, { tokens: { access_token: "fresh", token_type: "bearer" } }, home);
    expect((await syncValue(provider.tokens()))?.access_token).toBe("fresh");
  });

  test("sync getters skip reading the auth file when mtime and size are unchanged", async () => {
    const home = await tempHome();
    const provider = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
    });
    await provider.saveTokens({ access_token: "tok", token_type: "bearer" });
    expect((await syncValue(provider.tokens()))?.access_token).toBe("tok");

    const read = spyOn(fs, "readFileSync");
    try {
      expect((await syncValue(provider.tokens()))?.access_token).toBe("tok");
      expect(await syncValue(provider.clientInformation())).toBeUndefined();
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
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

  test("refreshToken posts grant_type=refresh_token with a resource and persists tokens", async () => {
    const home = await tempHome();
    await saveAuthState(
      linear,
      {
        clientInformation: clientInfo(1),
        tokens: {
          access_token: "stale",
          token_type: "bearer",
          refresh_token: "refresh-me",
        },
      },
      home,
    );

    const tokenBodies: string[] = [];
    const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const href = String(url);
      if (init?.method === "POST") {
        tokenBodies.push(String(init.body));
        return new Response(
          JSON.stringify({
            access_token: "fresh-access",
            token_type: "bearer",
            expires_in: 3600,
            refresh_token: "fresh-refresh",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (href.includes("oauth-protected-resource")) {
        return new Response(
          JSON.stringify({
            resource: "https://mcp.linear.app/mcp",
            authorization_servers: ["https://mcp.linear.app"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (href.includes("oauth-authorization-server") || href.includes("openid-configuration")) {
        return new Response(
          JSON.stringify({
            issuer: "https://mcp.linear.app",
            authorization_endpoint: "https://mcp.linear.app/authorize",
            token_endpoint: "https://mcp.linear.app/oauth/token",
            response_types_supported: ["code"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    };

    const provider = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
      fetchFn,
    });

    const tokens = await provider.refreshToken("refresh-me");
    expect(tokens.access_token).toBe("fresh-access");
    expect(tokenBodies).toHaveLength(1);
    const body = tokenBodies[0] ?? "";
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=refresh-me");
    expect(body).toContain(`resource=${encodeURIComponent("https://mcp.linear.app/mcp")}`);
    expect((await syncValue(provider.tokens()))?.access_token).toBe("fresh-access");
    expect((await loadAuthState(linear, home)).tokens?.access_token).toBe("fresh-access");
  });

  test("refreshToken wraps failures as UnauthorizedError", async () => {
    const home = await tempHome();
    await saveAuthState(linear, { clientInformation: clientInfo(1) }, home);

    const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const href = String(url);
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      if (href.includes("oauth-protected-resource")) {
        return new Response(
          JSON.stringify({
            resource: "https://mcp.linear.app/mcp",
            authorization_servers: ["https://mcp.linear.app"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (href.includes("oauth-authorization-server") || href.includes("openid-configuration")) {
        return new Response(
          JSON.stringify({
            issuer: "https://mcp.linear.app",
            authorization_endpoint: "https://mcp.linear.app/authorize",
            token_endpoint: "https://mcp.linear.app/oauth/token",
            response_types_supported: ["code"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    };

    const provider = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
      fetchFn,
    });

    await expect(provider.refreshToken("refresh-me")).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(provider.refreshToken("refresh-me")).rejects.toThrow(
      "Token refresh failed for linear",
    );
  });

  test("refreshToken fetch honors the connect AbortSignal", async () => {
    const home = await tempHome();
    await saveAuthState(linear, { clientInformation: clientInfo(1) }, home);
    const abort = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const fetchFn = fetchWithConnectAbort(abort.signal, (url, init) => {
      seen.push(init?.signal ?? undefined);
      const href = String(url);
      if (init?.method === "POST") {
        return new Promise<Response>((_resolve, reject) => {
          const fail = (): void => {
            reject(init.signal?.reason ?? new Error("aborted"));
          };
          if (init.signal?.aborted === true) fail();
          else init.signal?.addEventListener("abort", fail, { once: true });
        });
      }
      if (href.includes("oauth-protected-resource")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              resource: "https://mcp.linear.app/mcp",
              authorization_servers: ["https://mcp.linear.app"],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (href.includes("oauth-authorization-server") || href.includes("openid-configuration")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              issuer: "https://mcp.linear.app",
              authorization_endpoint: "https://mcp.linear.app/authorize",
              token_endpoint: "https://mcp.linear.app/oauth/token",
              response_types_supported: ["code"],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    const provider = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
      fetchFn,
    });

    const pending = provider.refreshToken("refresh-me");
    while (seen.every((signal) => signal !== abort.signal)) await Promise.resolve();
    abort.abort(new DOMException("toolset disposed", "AbortError"));
    await expect(pending).rejects.toThrow("toolset disposed");
    await expect(pending).rejects.not.toBeInstanceOf(UnauthorizedError);
    expect(seen.some((signal) => signal === abort.signal)).toBe(true);
  });
});
