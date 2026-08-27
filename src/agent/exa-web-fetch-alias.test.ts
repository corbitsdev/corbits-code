import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@intx/types/runtime";
import { stringTool, type AgentTool } from "@intx/agent";
import { withMockedModule } from "../../tests/helpers/mock-module.js";
import type { ResolvedMCPServerConfig } from "../mcp/exa.js";
import { createPermissionGate } from "../permission/gate.js";

const calls: { toolName: string; args: Record<string, unknown>; signal: AbortSignal }[] = [];
let connectConfigs: ResolvedMCPServerConfig[] = [];
let connectMode: "success" | "missing-fetch" | "failed" = "success";

await withMockedModule(
  import.meta.resolve("../mcp/client.js"),
  (real: typeof import("../mcp/client.js")) => ({
    ...real,
    connectMCPServer: async (config: ResolvedMCPServerConfig) => {
      connectConfigs.push(config);
      if (connectMode === "failed") {
        return { ok: false, serverName: config.name, error: "connection exploded" };
      }
      return {
        ok: true,
        client: {
          serverName: config.name,
          tools:
            connectMode === "missing-fetch"
              ? [{ name: "web_search_exa", description: "Search", inputSchema: {} }]
              : [
                  { name: "web_fetch_exa", description: "Fetch", inputSchema: {} },
                  { name: "web_search_exa", description: "Search", inputSchema: {} },
                ],
          call: async (toolName: string, args: Record<string, unknown>, signal: AbortSignal) => {
            calls.push({ toolName, args, signal });
            return "exa fetch result";
          },
          close: async () => undefined,
        },
      };
    },
  }),
);

const { createAgentToolset } = await import("./tools.js");
const { resolveMcpServers } = await import("../config/index.js");
const { coreSubAgentWebTools } = await import("../subagent/run.js");

function permissionGate() {
  return createPermissionGate({ approvals: [], interactive: false, skipPermissions: true });
}

async function makeToolset(mcpServers = resolveMcpServers(undefined, undefined)) {
  return createAgentToolset({
    cwd: mkdtempSync(join(tmpdir(), "corbits-exa-fetch-alias-")),
    permissionGate: permissionGate(),
    onOperatorGate: async () => ({ kind: "cancel" }),
    mcpServers,
  });
}

async function connect(toolset: Awaited<ReturnType<typeof createAgentToolset>>) {
  await toolset.connectMCP({
    interactiveAuth: false,
    onStatus: () => undefined,
    onToolsChanged: () => undefined,
  });
}

async function runTool(
  toolset: Awaited<ReturnType<typeof createAgentToolset>>,
  name: string,
  args: Record<string, unknown>,
  signal = new AbortController().signal,
): Promise<ToolResult> {
  return toolset.dynamicRunner.run({ id: `call-${name}`, name, arguments: args }, signal);
}

beforeEach(() => {
  calls.length = 0;
  connectConfigs = [];
  connectMode = "success";
});

describe("built-in Exa web_fetch alias", () => {
  test("advertises canonical web_fetch from turn 1 and hides the built-in raw fetch", async () => {
    const toolset = await makeToolset();
    try {
      const initialNames = toolset.dynamicRunner.currentDefinitions().map((d) => d.name);
      expect(initialNames).toContain("web_fetch");
      expect(initialNames).not.toContain("mcp__exa__web_fetch_exa");

      await connect(toolset);
      const connectedNames = toolset.dynamicRunner.currentDefinitions().map((d) => d.name);
      expect(connectedNames).toContain("web_fetch");
      expect(connectedNames).toContain("mcp__exa__web_search_exa");
      expect(connectedNames).not.toContain("mcp__exa__web_fetch_exa");
      expect(connectConfigs).toHaveLength(1);
    } finally {
      await toolset.dispose();
    }
  });

  test("disabled and custom Exa use ordinary native/raw behavior", async () => {
    const disabled = await makeToolset(
      resolveMcpServers([{ name: "exa", enabled: false }], undefined),
    );
    try {
      expect(disabled.dynamicRunner.currentDefinitions().map((d) => d.name)).toContain("web_fetch");
      await connect(disabled);
      expect(connectConfigs).toHaveLength(0);
    } finally {
      await disabled.dispose();
    }

    connectConfigs = [];
    const custom = await makeToolset(
      resolveMcpServers(
        [{ name: "exa", type: "http", url: "https://example.test/mcp" }],
        undefined,
      ),
    );
    try {
      await connect(custom);
      const names = custom.dynamicRunner.currentDefinitions().map((d) => d.name);
      expect(names).toContain("web_fetch");
      expect(names).toContain("mcp__exa__web_fetch_exa");
      expect(connectConfigs).toEqual([
        { name: "exa", type: "http", url: "https://example.test/mcp" },
      ]);
    } finally {
      await custom.dispose();
    }
  });

  test("canonical web_fetch preserves markdown while mapping to Exa MCP fetch shape", async () => {
    const toolset = await makeToolset();
    try {
      const controller = new AbortController();
      const connecting = connect(toolset);
      const result = await runTool(
        toolset,
        "web_fetch",
        { url: "https://example.com", format: "markdown", timeout: 12 },
        controller.signal,
      );
      await connecting;

      expect(result).toEqual({ callId: "call-web_fetch", content: "exa fetch result" });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        toolName: "web_fetch_exa",
        args: { urls: ["https://example.com"] },
      });
      expect(calls[0]?.args).not.toHaveProperty("url");
      expect(calls[0]?.args).not.toHaveProperty("format");
      expect(calls[0]?.args).not.toHaveProperty("timeout");
      expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await toolset.dispose();
    }
  });

  test("canonical web_fetch rejects non-http URLs before invoking Exa MCP", async () => {
    const toolset = await makeToolset();
    try {
      await connect(toolset);
      const result = await runTool(toolset, "web_fetch", { url: "ftp://example.com/file" });

      expect(result).not.toHaveProperty("isError");
      expect(result.content).toBe(
        'Error: Unsupported protocol "ftp:"; only http and https are allowed.',
      );
      expect(calls).toHaveLength(0);
    } finally {
      await toolset.dispose();
    }
  });

  test("canonical web_fetch returns explicit Exa MCP errors without native fallback", async () => {
    connectMode = "missing-fetch";
    const toolset = await makeToolset();
    try {
      await connect(toolset);
      const result = await runTool(toolset, "web_fetch", { url: "https://example.com" });
      expect(result).not.toHaveProperty("isError");
      expect(result.content).toContain("Exa MCP");
      expect(result.content).toContain("web_fetch_exa");
      expect(calls).toHaveLength(0);
    } finally {
      await toolset.dispose();
    }

    connectMode = "failed";
    const failed = await makeToolset();
    try {
      await connect(failed);
      const result = await runTool(failed, "web_fetch", { url: "https://example.com" });
      expect(result).not.toHaveProperty("isError");
      expect(result.content).toContain("Exa MCP");
      expect(result.content).toContain("connection exploded");
      expect(calls).toHaveLength(0);
    } finally {
      await failed.dispose();
    }
  });

  test("child assembly keeps inherited canonical web_fetch and avoids duplicate native fetch", () => {
    const inherited: AgentTool[] = [
      stringTool({
        definition: { name: "web_fetch", description: "Inherited Exa fetch", inputSchema: {} },
        handler: async () => "inherited",
      }),
    ];
    const names = [...coreSubAgentWebTools(inherited), ...inherited].map(
      (tool) => tool.definition.name,
    );
    expect(names.filter((name) => name === "web_fetch")).toHaveLength(1);
    expect(names).toContain("web_fetch");
    expect(names).toContain("web_search");
  });
});
