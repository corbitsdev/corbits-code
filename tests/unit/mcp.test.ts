import { test, expect, describe } from "bun:test";
import { isLocalSettings } from "../../src/settings.js";
import { createMCPPlugin } from "../../src/mcp/plugin.js";
import type { MCPClient } from "../../src/mcp/client.js";

describe("isLocalSettings with mcpServers", () => {
  test("accepts valid mcpServers array", () => {
    expect(
      isLocalSettings({
        mcpServers: [{ name: "linear", command: "npx", args: ["-y", "@linear/mcp"] }],
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
});

describe("createMCPPlugin", () => {
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

  test("namespaces tools as mcp__<server>__<tool>", () => {
    const client = makeFakeClient("linear", ["list_issues", "create_issue"]);
    const { plugin } = createMCPPlugin([client]);
    const names = plugin.tools!.map((t) => t.definition.name);
    expect(names).toEqual(["mcp__linear__list_issues", "mcp__linear__create_issue"]);
  });

  test("prefixes description with server name", () => {
    const client = makeFakeClient("github", ["search_repos"]);
    const { plugin } = createMCPPlugin([client]);
    expect(plugin.tools![0]!.definition.description).toBe("[github] search_repos tool");
  });

  test("returns connectedServers for all clients", () => {
    const clients = [makeFakeClient("a", ["t1"]), makeFakeClient("b", ["t2"])];
    const { connectedServers } = createMCPPlugin(clients);
    expect(connectedServers).toEqual(["a", "b"]);
  });

  test("returns empty tools and servers for empty client list", () => {
    const { plugin, connectedServers } = createMCPPlugin([]);
    expect(plugin.tools).toEqual([]);
    expect(connectedServers).toEqual([]);
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

    const { plugin } = createMCPPlugin([client]);
    const tool = plugin.tools![0]!;
    const result = await tool.handler(
      { id: "c1", name: "mcp__myserver__do_thing", arguments: { x: 1 } },
      new AbortController().signal,
    );

    expect(capturedName).toBe("do_thing");
    expect(capturedArgs).toEqual({ x: 1 });
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

    const { plugin } = createMCPPlugin([client]);
    const tool = plugin.tools![0]!;
    const result = await tool.handler(
      { id: "c1", name: "mcp__srv__fail", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("server error");
  });
});
