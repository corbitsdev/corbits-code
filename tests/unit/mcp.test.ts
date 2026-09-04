import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLocalSettings, normalizeMcpServers } from "../../src/config/settings.js";
import { mcpClientToAgentTools } from "../../src/mcp/plugin.js";
import { createPermissionGate } from "../../src/permission/gate.js";
import { loadAuthState, saveAuthState } from "../../src/mcp/auth-store.js";
import { createOAuthProvider } from "../../src/mcp/oauth-provider.js";
import { createDynamicToolRunner } from "../../src/tui/dynamic-tool-runner.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { MCPClient } from "../../src/mcp/client.js";
import { DuplicateToolError, type AgentTool } from "@intx/agent";

describe("isLocalSettings with mcpServers", () => {
  test("accepts valid mcpServers array", () => {
    expect(
      isLocalSettings({
        mcpServers: [{ name: "acme", command: "npx", args: ["-y", "@acme/mcp"] }],
      }),
    ).toBe(true);
  });

  test("accepts mcpServers with env", () => {
    expect(
      isLocalSettings({
        mcpServers: [
          { name: "mymcp", command: "node", args: ["server.js"], env: { TOKEN: "abc" } },
        ],
      }),
    ).toBe(true);
  });

  test("accepts combined provider, model, and mcpServers", () => {
    expect(
      isLocalSettings({
        provider: "zen",
        model: "gpt-4o",
        mcpServers: [{ name: "srv", command: "srv-bin" }],
      }),
    ).toBe(true);
  });

  test("rejects mcpServers entry missing name", () => {
    expect(
      isLocalSettings({
        mcpServers: [{ command: "bin" }],
      }),
    ).toBe(false);
  });

  test("rejects mcpServers entry missing command", () => {
    expect(
      isLocalSettings({
        mcpServers: [{ name: "srv" }],
      }),
    ).toBe(false);
  });

  test("rejects mcpServers entry with non-string args element", () => {
    expect(
      isLocalSettings({
        mcpServers: [{ name: "srv", command: "bin", args: [42] }],
      }),
    ).toBe(false);
  });

  test("rejects mcpServers entry with non-string env value", () => {
    expect(
      isLocalSettings({
        mcpServers: [{ name: "srv", command: "bin", env: { KEY: 123 } }],
      }),
    ).toBe(false);
  });

  test("still rejects unknown non-mcp keys", () => {
    expect(isLocalSettings({ apiKey: "secret" })).toBe(false);
  });

  test("accepts valid mcpServers object format", () => {
    expect(
      isLocalSettings({
        mcpServers: {
          acme: { command: "npx", args: ["-y", "mcp-remote", "https://mcp.acme.app/mcp"] },
        },
      }),
    ).toBe(true);
  });

  test("accepts mcpServers object format with env", () => {
    expect(
      isLocalSettings({
        mcpServers: {
          srv: { command: "node", args: ["server.js"], env: { TOKEN: "abc" } },
        },
      }),
    ).toBe(true);
  });

  test("accepts mcpServers object format missing command", () => {
    expect(
      isLocalSettings({
        mcpServers: {
          srv: { args: ["--flag"] },
        },
      }),
    ).toBe(false);
  });
});

function makeFakeClient(serverName: string, toolNames: string[]): MCPClient {
  return {
    serverName,
    tools: toolNames.map((name) => ({
      name,
      description: `${name} tool`,
      inputSchema: { type: "object", properties: {} },
    })),
    async call() {
      return "result";
    },
    async close() {},
  };
}

describe("mcpClientToAgentTools (production gated path)", () => {
  test("namespaces tools as mcp__<server>__<tool>", () => {
    const client = makeFakeClient("acme", ["list_issues", "create_issue"]);
    const gate = createPermissionGate({ approvals: [], interactive: false, skipPermissions: true });
    gate.registerMcpClient(client);
    const tools = mcpClientToAgentTools(client, gate);
    expect(tools.map((t) => t.definition.name)).toEqual([
      "mcp__acme__list_issues",
      "mcp__acme__create_issue",
    ]);
  });

  test("prefixes description with server name", () => {
    const client = makeFakeClient("github", ["search_repos"]);
    const gate = createPermissionGate({ approvals: [], interactive: false, skipPermissions: true });
    const tools = mcpClientToAgentTools(client, gate);
    expect(tools[0]!.definition.description).toBe("[github] search_repos tool");
  });

  test("tool handler returns call result", async () => {
    let capturedName: string | undefined;
    let capturedArgs: Record<string, unknown> | undefined;

    const client: MCPClient = {
      serverName: "myserver",
      tools: [{ name: "do_thing", description: "does thing", inputSchema: { type: "object" } }],
      async call(toolName, args) {
        capturedName = toolName;
        capturedArgs = args;
        return "done";
      },
      async close() {},
    };

    const gate = createPermissionGate({ approvals: [], interactive: false, skipPermissions: true });
    const tool = mcpClientToAgentTools(client, gate)[0]!;
    const result = await tool.handler(
      { id: "c1", name: "mcp__myserver__do_thing", arguments: { x: 1 } },
      new AbortController().signal,
    );

    expect(capturedName).toBe("do_thing");
    expect(capturedArgs).toEqual({ x: 1 });
    if (typeof result === "string") throw new Error("expected structured ToolResult");
    expect(result.content).toBe("done");
    expect(result.isError).toBeUndefined();
  });

  test("tool handler returns error result on throw", async () => {
    const client: MCPClient = {
      serverName: "srv",
      tools: [{ name: "fail", description: "", inputSchema: {} }],
      async call() {
        throw new Error("server error");
      },
      async close() {},
    };

    const gate = createPermissionGate({ approvals: [], interactive: false, skipPermissions: true });
    const tool = mcpClientToAgentTools(client, gate)[0]!;
    const result = await tool.handler(
      { id: "c1", name: "mcp__srv__fail", arguments: {} },
      new AbortController().signal,
    );

    if (typeof result === "string") throw new Error("expected structured ToolResult");
    expect(result.isError).toBe(true);
    expect(result.content).toBe("server error");
  });

  test("permission gate blocks mutating MCP when not skipped", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [],
      interactive: true,
      skipPermissions: false,
      requestApproval: async () => {
        asked++;
        return { allow: false };
      },
    });
    const client = makeFakeClient("acme", ["save_issue"]);
    gate.registerMcpClient(client);
    const tool = mcpClientToAgentTools(client, gate)[0]!;
    const result = await tool.handler(
      { id: "c1", name: "mcp__acme__save_issue", arguments: { id: "X-1" } },
      new AbortController().signal,
    );
    expect(asked).toBe(1);
    if (typeof result === "string") throw new Error("expected structured ToolResult");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Blocked by permission policy");
  });
});

describe("normalizeMcpServers", () => {
  test("returns undefined for undefined input", () => {
    expect(normalizeMcpServers(undefined)).toBeUndefined();
  });

  test("passes through array format unchanged", () => {
    const input = [{ name: "acme", command: "npx", args: ["-y", "mcp-remote"] }];
    expect(normalizeMcpServers(input)).toEqual(input);
  });

  test("converts object format to array format", () => {
    const input = {
      acme: { command: "npx", args: ["-y", "mcp-remote", "https://mcp.acme.app/mcp"] },
    };
    expect(normalizeMcpServers(input)).toEqual([
      { name: "acme", command: "npx", args: ["-y", "mcp-remote", "https://mcp.acme.app/mcp"] },
    ]);
  });

  test("converts object format with env", () => {
    const input = {
      srv: { command: "node", env: { TOKEN: "abc" } },
    };
    expect(normalizeMcpServers(input)).toEqual([
      { name: "srv", command: "node", env: { TOKEN: "abc" } },
    ]);
  });

  test("converts multi-key object format", () => {
    const input = {
      a: { command: "cmd-a" },
      b: { command: "cmd-b", args: ["--x"] },
    };
    const result = normalizeMcpServers(input);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ name: "a", command: "cmd-a" });
    expect(result).toContainEqual({ name: "b", command: "cmd-b", args: ["--x"] });
  });

  test("returns undefined for invalid array entry", () => {
    expect(normalizeMcpServers([{ command: "bin" }])).toBeUndefined();
  });

  test("returns undefined for invalid object entry", () => {
    expect(normalizeMcpServers({ srv: { args: ["--flag"] } })).toBeUndefined();
  });
});

describe("normalizeMcpServers with http transport", () => {
  test("accepts an http server by url", () => {
    expect(
      normalizeMcpServers({ acme: { type: "http", url: "https://mcp.acme.app/mcp" } }),
    ).toEqual([{ name: "acme", type: "http", url: "https://mcp.acme.app/mcp" }]);
  });

  test("infers http when only url is given", () => {
    expect(isLocalSettings({ mcpServers: { acme: { url: "https://mcp.acme.app/mcp" } } })).toBe(
      true,
    );
  });

  test("rejects an http server with no url", () => {
    expect(normalizeMcpServers({ acme: { type: "http" } })).toBeUndefined();
  });

  test("rejects an unknown transport type", () => {
    expect(normalizeMcpServers({ acme: { type: "ws", url: "wss://x" } })).toBeUndefined();
  });
});

const acmeAuthIdentity = { serverName: "acme", serverURL: "https://mcp.acme.app/mcp" };

describe("MCP auth store", () => {
  const tokens: OAuthTokens = { access_token: "tok", token_type: "Bearer" };

  test("round-trips state through disk", async () => {
    const home = await mkdtemp(join(tmpdir(), "intx-auth-"));
    try {
      expect(await loadAuthState(acmeAuthIdentity, home)).toEqual({});
      await saveAuthState(acmeAuthIdentity, { tokens, codeVerifier: "verifier" }, home);
      expect(await loadAuthState(acmeAuthIdentity, home)).toEqual({
        tokens,
        codeVerifier: "verifier",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("isolates state per server name", async () => {
    const home = await mkdtemp(join(tmpdir(), "intx-auth-"));
    try {
      await saveAuthState(acmeAuthIdentity, { tokens }, home);
      expect(
        await loadAuthState(
          { serverName: "github", serverURL: "https://mcp.github.example/mcp" },
          home,
        ),
      ).toEqual({});
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("OAuth provider", () => {
  test("redirectToAuthorization surfaces the URL instead of opening a browser", async () => {
    const home = await mkdtemp(join(tmpdir(), "intx-auth-"));
    try {
      const seen: { name: string; url: string }[] = [];
      const provider = await createOAuthProvider({
        serverName: "acme",
        serverURL: acmeAuthIdentity.serverURL,
        redirectUrl: "http://127.0.0.1:5599/callback",
        onAuthURL: (name, url) => seen.push({ name, url }),
        home,
      });
      provider.redirectToAuthorization(new URL("https://acme.app/oauth/authorize?client_id=abc"));
      expect(seen).toEqual([
        { name: "acme", url: "https://acme.app/oauth/authorize?client_id=abc" },
      ]);
      expect(provider.redirectUrl).toBe("http://127.0.0.1:5599/callback");
      expect(provider.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:5599/callback"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("supplies a stable, non-empty OAuth state parameter", async () => {
    const home = await mkdtemp(join(tmpdir(), "intx-auth-"));
    try {
      const provider = await createOAuthProvider({
        serverName: "acme",
        serverURL: acmeAuthIdentity.serverURL,
        redirectUrl: "http://127.0.0.1:0/cb",
        onAuthURL: () => {},
        home,
      });
      const first = await provider.state?.();
      expect(first).toBeTruthy();
      expect(await provider.state?.()).toBe(first);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("persists tokens so a later provider reads them back", async () => {
    const home = await mkdtemp(join(tmpdir(), "intx-auth-"));
    try {
      const first = await createOAuthProvider({
        serverName: "acme",
        serverURL: acmeAuthIdentity.serverURL,
        redirectUrl: "http://127.0.0.1:0/cb",
        onAuthURL: () => {},
        home,
      });
      await first.saveTokens({ access_token: "abc", token_type: "Bearer" });
      const second = await createOAuthProvider({
        serverName: "acme",
        serverURL: acmeAuthIdentity.serverURL,
        redirectUrl: "http://127.0.0.1:0/cb",
        onAuthURL: () => {},
        home,
      });
      expect(second.tokens()).toEqual({ access_token: "abc", token_type: "Bearer" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("can clear stale authorization before starting a fresh OAuth flow", async () => {
    const home = await mkdtemp(join(tmpdir(), "intx-auth-"));
    try {
      const provider = await createOAuthProvider({
        serverName: "acme",
        serverURL: acmeAuthIdentity.serverURL,
        redirectUrl: "http://127.0.0.1:0/cb",
        onAuthURL: () => {},
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
      expect(() => provider.codeVerifier()).toThrow("No PKCE code verifier saved");
      expect(await provider.state?.()).not.toBe(oldState);
      expect(await loadAuthState(acmeAuthIdentity, home)).toEqual({});
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("dynamic tool runner", () => {
  const makeTool = (name: string, result: string): AgentTool => ({
    kind: "string",
    definition: { name, description: name, inputSchema: { type: "object" } },
    handler: async () => result,
  });

  test("dispatches a tool added after construction", async () => {
    const runner = createDynamicToolRunner([makeTool("base", "base-result")]);
    runner.addTools([makeTool("mcp__acme__list", "late-result")]);

    expect(runner.currentDefinitions().map((d) => d.name)).toEqual(["base", "mcp__acme__list"]);
    const result = await runner.run(
      { id: "c1", name: "mcp__acme__list", arguments: {} },
      new AbortController().signal,
    );
    expect(result.content).toBe("late-result");
  });

  test("rejects a duplicate tool name", () => {
    const runner = createDynamicToolRunner([makeTool("dup", "x")]);
    expect(() => runner.addTools([makeTool("dup", "y")])).toThrow();
  });

  test("returns an error result for an unknown tool", async () => {
    const runner = createDynamicToolRunner([]);
    const result = await runner.run(
      { id: "c1", name: "missing", arguments: {} },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
  });

  test("removeTools drops a name, is idempotent, and allows re-add", async () => {
    const runner = createDynamicToolRunner([makeTool("base", "base-result")]);
    runner.addTools([makeTool("mcp__acme__list", "late-result")]);
    runner.removeTools(["mcp__acme__list"]);

    const missing = await runner.run(
      { id: "c1", name: "mcp__acme__list", arguments: {} },
      new AbortController().signal,
    );
    expect(missing.isError).toBe(true);
    expect(missing.content).toBe("unknown tool: mcp__acme__list");
    expect(runner.currentDefinitions().map((d) => d.name)).toEqual(["base"]);

    expect(() => runner.removeTools(["mcp__acme__list"])).not.toThrow();
    expect(() => runner.addTools([makeTool("mcp__acme__list", "again")])).not.toThrow(
      DuplicateToolError,
    );
    const restored = await runner.run(
      { id: "c2", name: "mcp__acme__list", arguments: {} },
      new AbortController().signal,
    );
    expect(restored.content).toBe("again");
  });
});
