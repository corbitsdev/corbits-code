import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  authFilePath,
  loadAuthState,
  saveAuthState,
  deleteAuthState,
} from "./auth-store.js";
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

const linear = {
  serverName: "linear",
  serverURL: "https://mcp.linear.app/mcp",
};

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

// Canned discovery endpoints; the POST branch is per-test (token endpoint
// behavior varies by scenario).
function linearDiscoveryFetch(
  onPost: (init: RequestInit) => Promise<Response>,
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const href = String(url);
    if (init?.method === "POST") {
      return onPost(init);
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
    if (
      href.includes("oauth-authorization-server") ||
      href.includes("openid-configuration")
    ) {
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
}

type OAuthProvider = Awaited<ReturnType<typeof createOAuthProvider>>;

async function expectClientOnPort(
  provider: OAuthProvider,
  port: number,
  clientId = `client-on-${String(port)}`,
): Promise<void> {
  const info = await syncValue(provider.clientInformation());
  expect(info?.client_id).toBe(clientId);
  expect(
    info && "redirect_uris" in info ? info.redirect_uris : undefined,
  ).toEqual([`http://127.0.0.1:${String(port)}/callback`]);
}

async function expectStoredClient(
  home: string,
  clientId: string,
  port: number,
): Promise<void> {
  const disk = await loadAuthState(linear, home);
  expect(disk.clientInformation?.client_id).toBe(clientId);
  expect(disk.clientInformation?.redirect_uris).toEqual([
    `http://127.0.0.1:${String(port)}/callback`,
  ]);
}

describe("createOAuthProvider", () => {
  test("drops stale DCR client when redirect port changed and no tokens exist", async () => {
    const home = await tempHome();
    // Legacy file: stale registration plus a disk-flowed PKCE verifier; both
    // must be scrubbed, not persisted.
    const path = authFilePath(linear, home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        clientInformation: clientInfo(60435),
        codeVerifier: "old-verifier",
      }),
    );

    const provider = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:62000/callback",
      onAuthURL: () => undefined,
      home,
    });

    expect(await syncValue(provider.clientInformation())).toBeUndefined();
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("client-on-60435");
    expect(raw).not.toContain("codeVerifier");
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

    expect((await syncValue(provider.clientInformation()))?.client_id).toBe(
      "client-on-60435",
    );
    expect((await syncValue(provider.tokens()))?.access_token).toBe("live");
  });

  test("concurrent saveTokens and saveCodeVerifier keep tokens on disk and the verifier in memory", async () => {
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

    // Verifier is instance-local: b reads its own, a has none, and the
    // memory-only save cannot clobber the disk tokens.
    expect(b.codeVerifier()).toBe("verifier-b");
    expect(() => a.codeVerifier()).toThrow("No PKCE code verifier saved");
    const disk = await loadAuthState(linear, home);
    expect(disk.tokens?.access_token).toBe("tok-a");
    expect("codeVerifier" in disk).toBe(false);
  });

  test("never writes the PKCE verifier to disk across a full browser-flow save sequence", async () => {
    const home = await tempHome();
    const provider = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:62000/callback",
      onAuthURL: () => undefined,
      home,
    });
    // SDK browser flow persists client info, then verifier, then tokens.
    await saveClient(provider, clientInfo(62000));
    await provider.saveCodeVerifier("pkce-one-time");
    await provider.saveTokens({
      access_token: "tok",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "ref",
    });

    expect(provider.codeVerifier()).toBe("pkce-one-time");
    const raw = await readFile(authFilePath(linear, home), "utf8");
    expect(raw).not.toContain("codeVerifier");
    expect(raw).not.toContain("pkce-one-time");
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      "clientInformation",
      "tokens",
    ]);
  });

  test("drops in-memory tokens once the auth file is deleted", async () => {
    const home = await tempHome();
    const provider = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
    });
    await saveClient(provider, clientInfo(1));
    await provider.saveTokens({ access_token: "tok", token_type: "bearer" });
    expect((await syncValue(provider.tokens()))?.access_token).toBe("tok");

    await deleteAuthState(linear, home);

    expect(await syncValue(provider.tokens())).toBeUndefined();
  });

  test("keeps live tokens when the auth file is unreadable but drops them on delete", async () => {
    const home = await tempHome();
    const provider = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
    });
    await saveClient(provider, clientInfo(1));
    await provider.saveTokens({ access_token: "tok", token_type: "bearer" });
    expect((await syncValue(provider.tokens()))?.access_token).toBe("tok");

    // Transient stat failure (EACCES, file present) must not discard live
    // credentials; only a real deletion (ENOENT) does.
    const dir = dirname(authFilePath(linear, home));
    await chmod(dir, 0o000);
    try {
      expect((await syncValue(provider.tokens()))?.access_token).toBe("tok");
    } finally {
      await chmod(dir, 0o700);
    }

    await deleteAuthState(linear, home);

    expect(await syncValue(provider.tokens())).toBeUndefined();
  });

  test("two overlapping logins on different ports both complete without clobbering verifiers", async () => {
    const home = await tempHome();
    const a = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:62000/callback",
      onAuthURL: () => undefined,
      home,
    });
    const b = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:60435/callback",
      onAuthURL: () => undefined,
      home,
    });

    await saveClient(a, clientInfo(62000));
    await a.saveCodeVerifier("pkce-a");
    await saveClient(b, clientInfo(60435));
    await b.saveCodeVerifier("pkce-b");

    await a.saveTokens({
      access_token: "tok-a",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "ref-a",
    });
    await b.saveTokens({
      access_token: "tok-b",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "ref-b",
    });

    // Each episode keeps its own verifier; neither clobbers the other.
    expect(a.codeVerifier()).toBe("pkce-a");
    expect(b.codeVerifier()).toBe("pkce-b");
    // The verifier is transient: the shared file holds the completed auth only.
    const raw = await readFile(authFilePath(linear, home), "utf8");
    expect(raw).not.toContain("codeVerifier");
    expect(raw).not.toContain("pkce-a");
    expect(raw).not.toContain("pkce-b");
    // Last completer wins the durable tokens; the sibling picks them up.
    expect((await loadAuthState(linear, home)).tokens?.access_token).toBe(
      "tok-b",
    );
    expect((await syncValue(a.tokens()))?.access_token).toBe("tok-b");
    expect((await syncValue(b.tokens()))?.access_token).toBe("tok-b");
    await expectClientOnPort(b, 60435);
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

  test("resetAuthorization does not delete a sibling's just-saved tokens", async () => {
    const home = await tempHome();
    const a = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:62000/callback",
      onAuthURL: () => undefined,
      home,
    });
    const b = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:60435/callback",
      onAuthURL: () => undefined,
      home,
    });

    await a.saveTokens({
      access_token: "fresh",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "fresh-refresh",
    });
    expect((await syncValue(a.tokens()))?.access_token).toBe("fresh");

    await b.resetAuthorization();

    expect((await syncValue(a.tokens()))?.access_token).toBe("fresh");
    expect((await loadAuthState(linear, home)).tokens?.access_token).toBe(
      "fresh",
    );
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
    await custom.saveTokens({
      access_token: "custom-secret",
      token_type: "bearer",
    });

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
    expect((await syncValue(customAgain.tokens()))?.access_token).toBe(
      "custom-secret",
    );
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
    expect((await syncValue(a.clientInformation()))?.client_id).toBe(
      "client-on-62000",
    );

    await saveClient(b, clientInfo(60435));
    await expectClientOnPort(a, 62000);
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

    await expectClientOnPort(a, 62000);
    await expectStoredClient(home, "client-on-62000", 62000);
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
    expect(disk.clientInformation?.redirect_uris).toEqual([
      "http://127.0.0.1:60435/callback",
    ]);
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

    await expectClientOnPort(a, 62000, "client-on-62000-v2");
    await expectStoredClient(home, "client-on-62000-v2", 62000);
  });

  test("drops in-memory tokens when the auth file disappears and adopts a later sibling save", async () => {
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

    // Server-side removal must not leave orphaned credentials behind.
    await deleteAuthState(linear, home);

    expect(await syncValue(provider.tokens())).toBeUndefined();

    // The provider stays live: a sibling session's fresh auth is adopted.
    await saveAuthState(
      linear,
      { tokens: { access_token: "reauthed", token_type: "bearer" } },
      home,
    );
    expect((await syncValue(provider.tokens()))?.access_token).toBe("reauthed");
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
    await saveAuthState(
      linear,
      { tokens: { access_token: "fresh", token_type: "bearer" } },
      home,
    );
    expect((await syncValue(provider.tokens()))?.access_token).toBe("fresh");
  });

  test("does not delete scoped state whose filename stem is another provider name", async () => {
    const home = await tempHome();
    const dir = join(home, ".corbits", "mcp-auth");
    const existingIdentity = {
      serverName: "exa",
      serverURL: "https://custom.example/mcp",
    };
    await saveAuthState(
      existingIdentity,
      { tokens: { access_token: "scoped-secret", token_type: "bearer" } },
      home,
    );
    const [scopedFilename] = await Array.fromAsync(
      new Bun.Glob("exa-*.json").scan(dir),
    );
    expect(scopedFilename).toBeDefined();
    const collidingName =
      scopedFilename?.slice(0, -".json".length) ?? "missing";

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
    expect((await syncValue(existingProvider.tokens()))?.access_token).toBe(
      "scoped-secret",
    );
    expect(
      (await loadAuthState(existingIdentity, home)).tokens?.access_token,
    ).toBe("scoped-secret");
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
    const fetchFn = linearDiscoveryFetch(async (init) => {
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
    });

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
    expect(body).toContain(
      `resource=${encodeURIComponent("https://mcp.linear.app/mcp")}`,
    );
    expect((await syncValue(provider.tokens()))?.access_token).toBe(
      "fresh-access",
    );
    expect((await loadAuthState(linear, home)).tokens?.access_token).toBe(
      "fresh-access",
    );
  });

  test("refreshToken wraps failures as UnauthorizedError", async () => {
    const home = await tempHome();
    await saveAuthState(linear, { clientInformation: clientInfo(1) }, home);

    const fetchFn = linearDiscoveryFetch(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );

    const provider = await createOAuthProvider({
      serverName: "linear",
      serverURL: linear.serverURL,
      redirectUrl: "http://127.0.0.1:1/callback",
      onAuthURL: () => undefined,
      home,
      fetchFn,
    });

    await expect(provider.refreshToken("refresh-me")).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(provider.refreshToken("refresh-me")).rejects.toThrow(
      "Token refresh failed for linear",
    );
  });

  test("refreshToken fetch honors the connect AbortSignal", async () => {
    const home = await tempHome();
    await saveAuthState(linear, { clientInformation: clientInfo(1) }, home);
    const abort = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const discoveryFetch = linearDiscoveryFetch(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          const fail = (): void => {
            reject(init.signal?.reason ?? new Error("aborted"));
          };
          if (init.signal?.aborted === true) fail();
          else init.signal?.addEventListener("abort", fail, { once: true });
        }),
    );
    const fetchFn = fetchWithConnectAbort(abort.signal, (url, init) => {
      seen.push(init?.signal ?? undefined);
      return discoveryFetch(url, init);
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
    while (seen.every((signal) => signal !== abort.signal))
      await Promise.resolve();
    abort.abort(new DOMException("toolset disposed", "AbortError"));
    await expect(pending).rejects.toThrow("toolset disposed");
    await expect(pending).rejects.not.toBeInstanceOf(UnauthorizedError);
    expect(seen.some((signal) => signal === abort.signal)).toBe(true);
  });
});

describe("OAuth provider auth URL and state", () => {
  const acme = {
    serverName: "acme",
    serverURL: "https://mcp.acme.app/mcp",
  };

  test("redirectToAuthorization surfaces the URL instead of opening a browser", async () => {
    const home = await tempHome();
    const seen: { name: string; url: string }[] = [];
    const provider = await createOAuthProvider({
      serverName: "acme",
      serverURL: acme.serverURL,
      redirectUrl: "http://127.0.0.1:5599/callback",
      onAuthURL: (name, url) => seen.push({ name, url }),
      home,
    });
    provider.redirectToAuthorization(
      new URL("https://acme.app/oauth/authorize?client_id=abc"),
    );
    expect(seen).toEqual([
      { name: "acme", url: "https://acme.app/oauth/authorize?client_id=abc" },
    ]);
    expect(provider.redirectUrl).toBe("http://127.0.0.1:5599/callback");
    expect(provider.clientMetadata.redirect_uris).toEqual([
      "http://127.0.0.1:5599/callback",
    ]);
  });

  test("supplies a stable, non-empty OAuth state parameter", async () => {
    const home = await tempHome();
    const provider = await createOAuthProvider({
      serverName: "acme",
      serverURL: acme.serverURL,
      redirectUrl: "http://127.0.0.1:0/cb",
      onAuthURL: () => undefined,
      home,
    });
    const first = await provider.state?.();
    expect(first).toBeTruthy();
    expect(await provider.state?.()).toBe(first);
  });

  test("can clear stale authorization before starting a fresh OAuth flow", async () => {
    const home = await tempHome();
    const provider = await createOAuthProvider({
      serverName: "acme",
      serverURL: acme.serverURL,
      redirectUrl: "http://127.0.0.1:0/cb",
      onAuthURL: () => undefined,
      home,
    });
    await provider.saveTokens({
      access_token: "abc",
      refresh_token: "stale",
      token_type: "Bearer",
    });
    await provider.saveCodeVerifier("old-verifier");
    const oldState = await provider.state?.();

    await provider.resetAuthorization();

    expect(provider.tokens()).toBeUndefined();
    expect(() => provider.codeVerifier()).toThrow(
      "No PKCE code verifier saved",
    );
    expect(await provider.state?.()).not.toBe(oldState);
    expect(await loadAuthState(acme, home)).toEqual({});
  });
});
