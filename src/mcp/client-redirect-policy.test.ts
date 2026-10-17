import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test } from "bun:test";
import { saveAuthState } from "./auth-store.js";
import { streamableHTTPTransportOptions } from "./client.js";
import { createOAuthProvider } from "./oauth-provider.js";

const SERVER_URL = "https://mcp.example/mcp";
const OFF_ORIGIN = "https://evil.example/collect";

const RESOURCE_METADATA = {
  resource: SERVER_URL,
  authorization_servers: ["https://mcp.example"],
};

const AUTH_SERVER_METADATA = {
  issuer: "https://mcp.example",
  authorization_endpoint: "https://mcp.example/authorize",
  token_endpoint: "https://mcp.example/oauth/token",
  response_types_supported: ["code"],
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 308, headers: { location } });
}

async function saveTestProvider(home: string) {
  const identity = { serverName: "example", serverURL: SERVER_URL };
  await saveAuthState(
    identity,
    {
      clientInformation: {
        client_id: "client",
        redirect_uris: ["http://127.0.0.1:1/callback"],
        client_id_issued_at: 1,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "interchange-code",
      },
    },
    home,
  );
  const provider = await createOAuthProvider({
    serverName: identity.serverName,
    serverURL: identity.serverURL,
    redirectUrl: "http://127.0.0.1:1/callback",
    onAuthURL: () => undefined,
    home,
  });
  await provider.saveCodeVerifier("verifier");
  return provider;
}

describe("HTTP MCP redirect policy", () => {
  test("discovery and token fetches do not follow a cross-origin redirect", async () => {
    const home = await mkdtemp(join(tmpdir(), "mcp-redirect-"));
    const provider = await saveTestProvider(home);

    const abort = new AbortController();
    const options = streamableHTTPTransportOptions(provider, abort.signal);
    expect(options).toMatchObject({ redirectPolicy: "same-origin" });

    const requested: string[] = [];
    const fetchFn = async (
      url: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const href = String(url);
      requested.push(href);
      const target = new URL(href);
      if (target.hostname === "evil.example") {
        return new Response("collected", { status: 200 });
      }
      const crossOrigin =
        target.pathname === "/.well-known/oauth-protected-resource/mcp" ||
        target.pathname === "/oauth/token";
      if (!crossOrigin) {
        if (target.pathname === "/.well-known/oauth-protected-resource") {
          return json(RESOURCE_METADATA);
        }
        if (target.pathname === "/.well-known/oauth-authorization-server") {
          return json(AUTH_SERVER_METADATA);
        }
        return new Response(null, { status: 404 });
      }
      const redirect = new Response(null, {
        status: 308,
        headers: { location: OFF_ORIGIN },
      });
      const mode = init?.redirect ?? "follow";
      if (mode === "error") throw new TypeError("redirect mode is error");
      if (mode === "manual") return redirect;
      return fetchFn(OFF_ORIGIN, init);
    };

    const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
      ...options,
      fetch: fetchFn,
    });
    await expect(transport.finishAuth("auth-code")).rejects.toThrow();

    expect(requested.some((href) => href.includes("evil.example"))).toBe(false);
    expect(
      requested.some((href) =>
        href.includes("/.well-known/oauth-protected-resource/mcp"),
      ),
    ).toBe(true);
    expect(requested.some((href) => href.includes("/oauth/token"))).toBe(true);
    const tokenPost = requested.find((href) => href.includes("/oauth/token"));
    expect(tokenPost?.startsWith("https://mcp.example/")).toBe(true);
  });

  test("same-origin discovery and token redirects are followed (CL-10758)", async () => {
    const home = await mkdtemp(join(tmpdir(), "mcp-redirect-"));
    const provider = await saveTestProvider(home);

    const abort = new AbortController();
    const options = streamableHTTPTransportOptions(provider, abort.signal);
    expect(options).toMatchObject({ redirectPolicy: "same-origin" });

    const requested: string[] = [];
    const fetchFn = async (
      url: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const href = String(url);
      requested.push(href);
      const target = new URL(href);
      // The stub only answers manual redirects: the SDK follows same-origin
      // chains itself and never lets fetch follow across origins.
      if (init?.redirect !== "manual")
        throw new Error(`expected redirect manual, got ${init?.redirect}`);
      if (target.hostname !== "mcp.example")
        return new Response("collected", { status: 200 });
      if (
        target.pathname === "/.well-known/oauth-protected-resource/mcp" ||
        target.pathname === "/.well-known/oauth-protected-resource"
      ) {
        return redirectTo(
          "https://mcp.example/.well-known/oauth-protected-resource/mcp-2",
        );
      }
      if (target.pathname === "/.well-known/oauth-protected-resource/mcp-2") {
        return json(RESOURCE_METADATA);
      }
      if (target.pathname === "/.well-known/oauth-authorization-server") {
        return json(AUTH_SERVER_METADATA);
      }
      if (target.pathname === "/oauth/token") {
        return redirectTo("https://mcp.example/oauth/token-final");
      }
      if (target.pathname === "/oauth/token-final") {
        return json({ access_token: "access", token_type: "Bearer" });
      }
      return new Response(null, { status: 404 });
    };

    const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
      ...options,
      fetch: fetchFn,
    });
    // finishAuth resolves (void) once the code exchange completes; the
    // redirect targets below prove the same-origin hops were followed.
    await expect(transport.finishAuth("auth-code")).resolves.toBeUndefined();

    expect(requested.some((href) => href.includes("evil.example"))).toBe(false);
    expect(
      requested.some((href) =>
        href.includes("/.well-known/oauth-protected-resource/mcp-2"),
      ),
    ).toBe(true);
    expect(requested.some((href) => href.includes("/oauth/token-final"))).toBe(
      true,
    );
  });

  test("a same-origin token redirect chain past the SDK cap fails bounded (CL-10758)", async () => {
    const home = await mkdtemp(join(tmpdir(), "mcp-redirect-"));
    const provider = await saveTestProvider(home);

    const abort = new AbortController();
    const options = streamableHTTPTransportOptions(provider, abort.signal);

    const requested: string[] = [];
    const fetchFn = async (
      url: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const href = String(url);
      requested.push(href);
      const target = new URL(href);
      if (init?.redirect !== "manual")
        throw new Error(`expected redirect manual, got ${init?.redirect}`);
      if (
        target.pathname === "/.well-known/oauth-protected-resource/mcp" ||
        target.pathname === "/.well-known/oauth-protected-resource"
      ) {
        return json(RESOURCE_METADATA);
      }
      if (target.pathname === "/.well-known/oauth-authorization-server") {
        return json(AUTH_SERVER_METADATA);
      }
      const hop = /^\/oauth\/token(?:-(\d+))?$/.exec(target.pathname);
      if (hop !== null) {
        const depth = hop[1] === undefined ? 0 : Number(hop[1]);
        // Eight same-origin hops with a 200 past the end: the SDK must stop
        // following before it gets there.
        if (depth < 8)
          return redirectTo(`https://mcp.example/oauth/token-${depth + 1}`);
        return json({ access_token: "access", token_type: "Bearer" });
      }
      return new Response(null, { status: 404 });
    };

    const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
      ...options,
      fetch: fetchFn,
    });
    await expect(transport.finishAuth("auth-code")).rejects.toThrow();

    expect(requested.some((href) => href.includes("evil.example"))).toBe(false);
    const tokenHits = requested.filter((href) => href.includes("/oauth/token"));
    // SDK MAX_REDIRECTS (5) plus the initial POST: the 200 at depth 8 is
    // never reached, and the chain cannot loop forever.
    expect(tokenHits).toHaveLength(6);
    expect(
      tokenHits.every((href) => href.startsWith("https://mcp.example/")),
    ).toBe(true);
  });
});
