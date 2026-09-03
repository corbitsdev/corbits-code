import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@intx/types/runtime";
import { stringTool, type AgentTool } from "@intx/agent";
import { withMockedModule } from "../../tests/helpers/mock-module.js";
import { createExaMCPServerConfig, type ResolvedMCPServerConfig } from "../mcp/exa.js";
import type { MCPConnectOptions } from "../mcp/client.js";
import { createGlobalSettingsWriter, persistGlobalHTTPMCPServer } from "../mcp/add-server.js";
import { createPermissionGate } from "../permission/gate.js";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const calls: { toolName: string; args: Record<string, unknown>; signal: AbortSignal }[] = [];
const closedClients: string[] = [];
const closedGenerations: number[] = [];
let connectGeneration = 0;
let connectConfigs: ResolvedMCPServerConfig[] = [];
let connectOptions: MCPConnectOptions[] = [];
let releaseDeferredConnect: (() => void) | undefined;
let authWaitAborts = 0;
let authResourceCloses = 0;
let blockInteractiveAuth = false;
let connectMode: "success" | "missing-fetch" | "failed" | "rejected" | "auth" | "deferred" =
  "success";

await withMockedModule(
  import.meta.resolve("../mcp/client.js"),
  (real: typeof import("../mcp/client.js")) => ({
    ...real,
    connectMCPServer: async (config: ResolvedMCPServerConfig, options: MCPConnectOptions = {}) => {
      connectConfigs.push(config);
      connectOptions.push(options);
      const generation = ++connectGeneration;
      if (connectMode === "auth" || blockInteractiveAuth) {
        options.onAuthURL?.(config.name, "https://auth.test/authorize");
      }
      if (blockInteractiveAuth) {
        await new Promise<void>((resolve) => {
          const onAbort = (): void => {
            authWaitAborts += 1;
            authResourceCloses += 1;
            resolve();
          };
          if (options.signal?.aborted === true) {
            onAbort();
          } else {
            options.signal?.addEventListener("abort", onAbort, { once: true });
          }
        });
        return { ok: false, serverName: config.name, error: "authorization aborted" };
      }
      if (connectMode === "deferred") {
        await new Promise<void>((resolve) => {
          releaseDeferredConnect = resolve;
        });
      }
      if (connectMode === "rejected") throw new Error("transport setup exploded");
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
          close: async () => {
            closedClients.push(config.name);
            closedGenerations.push(generation);
          },
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

async function makeToolset(
  mcpServers = resolveMcpServers(undefined, undefined),
  gate = permissionGate(),
) {
  return createAgentToolset({
    cwd: tempDir("corbits-exa-fetch-alias-"),
    permissionGate: gate,
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
  closedClients.length = 0;
  closedGenerations.length = 0;
  connectGeneration = 0;
  connectConfigs = [];
  connectOptions = [];
  releaseDeferredConnect = undefined;
  authWaitAborts = 0;
  authResourceCloses = 0;
  blockInteractiveAuth = false;
  connectMode = "success";
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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

  test("single-server connection deduplicates and hands OAuth status through", async () => {
    connectMode = "auth";
    const toolset = await makeToolset(
      resolveMcpServers([{ name: "exa", enabled: false }], undefined),
    );
    const states: { state: string; url?: string }[] = [];
    const callbacks = {
      interactiveAuth: true,
      onStatus: (status: { state: string; url?: string }) => states.push(status),
      onToolsChanged: () => undefined,
    };
    const server = { name: "linear", type: "http" as const, url: "https://mcp.linear.app/mcp" };
    try {
      await Promise.all([
        toolset.connectMCPServer(server, callbacks),
        toolset.connectMCPServer(server, callbacks),
      ]);
      await toolset.connectMCPServer(server, callbacks);

      expect(connectConfigs).toEqual([server]);
      expect(states.map((status) => status.state)).toEqual([
        "connecting",
        "needs-auth",
        "connected",
      ]);
      expect(states[1]?.url).toBe("https://auth.test/authorize");
      expect(connectOptions[0]?.onAuthURL).toBeDefined();
    } finally {
      await toolset.dispose();
    }
  });

  test("dispose invalidates an in-flight connection and closes its late client", async () => {
    connectMode = "deferred";
    const toolset = await makeToolset(
      resolveMcpServers([{ name: "exa", enabled: false }], undefined),
    );
    const states: string[] = [];
    const connection = toolset.connectMCPServer(
      { name: "linear", type: "http", url: "https://mcp.linear.app/mcp" },
      {
        interactiveAuth: true,
        onStatus: (status) => states.push(status.state),
        onToolsChanged: () => undefined,
      },
    );
    await Promise.resolve();

    let disposed = false;
    const disposal = toolset.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    releaseDeferredConnect?.();
    await Promise.all([connection, disposal]);

    expect(states).toEqual(["connecting"]);
    expect(closedClients).toEqual(["linear"]);
    expect(
      toolset.dynamicRunner.currentDefinitions().some((tool) => tool.name.includes("linear")),
    ).toBe(false);
  });

  test("dispose aborts blocked interactive auth and closes its resources", async () => {
    blockInteractiveAuth = true;
    const toolset = await makeToolset(
      resolveMcpServers([{ name: "exa", enabled: false }], undefined),
    );
    const callerAbort = new AbortController();
    const states: string[] = [];
    const connection = toolset.connectMCPServer(
      { name: "linear", type: "http", url: "https://mcp.linear.app/mcp" },
      {
        interactiveAuth: true,
        onStatus: (status) => states.push(status.state),
        onToolsChanged: () => undefined,
      },
      callerAbort.signal,
    );
    while (connectOptions.length === 0) await Promise.resolve();

    const ownedSignal = connectOptions[0]?.signal;
    expect(ownedSignal).toBeDefined();
    expect(ownedSignal).not.toBe(callerAbort.signal);
    const disposal = toolset.dispose();
    expect(toolset.dispose()).toBe(disposal);
    await Promise.resolve();
    expect(ownedSignal?.aborted).toBe(true);
    expect(callerAbort.signal.aborted).toBe(false);
    await Promise.all([connection, disposal]);

    expect(authWaitAborts).toBe(1);
    expect(authResourceCloses).toBe(1);
    expect(states).toEqual(["connecting", "needs-auth"]);
    expect(
      toolset.dynamicRunner.currentDefinitions().some((tool) => tool.name.includes("linear")),
    ).toBe(false);
  });

  test("rejects connected and in-flight implicit Exa names before persistence", async () => {
    const connected = await makeToolset();
    const connectedPath = join(tempDir("corbits-mcp-active-"), "settings.json");
    try {
      await connect(connected);
      expect(connected.hasMCPServer("exa")).toBe(true);
      expect(
        await persistGlobalHTTPMCPServer(
          createGlobalSettingsWriter(connectedPath),
          "exa",
          "https://custom.test/mcp",
          "none",
          connected.hasMCPServer,
        ),
      ).toEqual({ ok: false, reason: "active" });
      expect(await Bun.file(connectedPath).exists()).toBe(false);
    } finally {
      await connected.dispose();
    }

    connectMode = "deferred";
    const inFlight = await makeToolset();
    const inFlightPath = join(tempDir("corbits-mcp-active-"), "settings.json");
    const startup = connect(inFlight);
    while (releaseDeferredConnect === undefined) await Promise.resolve();
    try {
      expect(inFlight.hasMCPServer("exa")).toBe(true);
      expect(
        await persistGlobalHTTPMCPServer(
          createGlobalSettingsWriter(inFlightPath),
          "exa",
          "https://custom.test/mcp",
          "none",
          inFlight.hasMCPServer,
        ),
      ).toEqual({ ok: false, reason: "active" });
      expect(await Bun.file(inFlightPath).exists()).toBe(false);
    } finally {
      releaseDeferredConnect?.();
      await startup;
      await inFlight.dispose();
    }
  });

  test("failed implicit Exa is not active and retries without a second persist", async () => {
    connectMode = "failed";
    const toolset = await makeToolset();
    const path = join(tempDir("corbits-mcp-failed-exa-"), "settings.json");
    try {
      await connect(toolset);
      expect(toolset.hasMCPServer("exa")).toBe(false);
      expect(
        await persistGlobalHTTPMCPServer(
          createGlobalSettingsWriter(path),
          "exa",
          "https://custom.test/mcp",
          "none",
          toolset.hasMCPServer,
        ),
      ).toMatchObject({ ok: true, server: { name: "exa" } });

      connectMode = "success";
      await toolset.connectMCPServer(createExaMCPServerConfig(), {
        interactiveAuth: false,
        onStatus: () => undefined,
        onToolsChanged: () => undefined,
      });
      expect(toolset.hasMCPServer("exa")).toBe(true);
    } finally {
      await toolset.dispose();
    }
  });

  test("single-server registration failure closes the client and reports failed", async () => {
    const gate = permissionGate();
    gate.registerMcpClient = () => {
      throw new Error("registration exploded");
    };
    const toolset = await makeToolset(
      resolveMcpServers([{ name: "exa", enabled: false }], undefined),
      gate,
    );
    const states: { state: string; error?: string }[] = [];
    try {
      await toolset.connectMCPServer(
        { name: "linear", type: "http", url: "https://mcp.linear.app/mcp" },
        {
          interactiveAuth: true,
          onStatus: (status) => states.push(status),
          onToolsChanged: () => undefined,
        },
      );

      expect(states.map((status) => status.state)).toEqual(["connecting", "failed"]);
      expect(states[1]?.error).toContain("registration exploded");
      expect(closedClients).toEqual(["linear"]);
    } finally {
      await toolset.dispose();
    }
  });

  test("rejected single-server connection reports failed without registration or client leaks", async () => {
    connectMode = "rejected";
    const gate = permissionGate();
    let registrations = 0;
    let unregistrations = 0;
    gate.registerMcpClient = () => {
      registrations += 1;
    };
    gate.unregisterMcpServer = () => {
      unregistrations += 1;
    };
    const toolset = await makeToolset(
      resolveMcpServers([{ name: "exa", enabled: false }], undefined),
      gate,
    );
    const server = { name: "linear", type: "http" as const, url: "https://mcp.linear.app/mcp" };
    const states: { state: string; error?: string }[] = [];
    try {
      await toolset.connectMCPServer(server, {
        interactiveAuth: true,
        onStatus: (status) => states.push(status),
        onToolsChanged: () => undefined,
      });

      expect(states.map((status) => status.state)).toEqual(["connecting", "failed"]);
      expect(states[1]?.error).toContain("transport setup exploded");
      expect(registrations).toBe(0);
      expect(unregistrations).toBe(0);
      expect(closedClients).toEqual([]);
      expect(
        toolset.dynamicRunner.currentDefinitions().some((tool) => tool.name.includes("linear")),
      ).toBe(false);
      expect(toolset.hasMCPServer("linear")).toBe(false);

      connectMode = "failed";
      const retryStates: string[] = [];
      await toolset.connectMCPServer(server, {
        interactiveAuth: true,
        onStatus: (status) => retryStates.push(status.state),
        onToolsChanged: () => undefined,
      });
      expect(retryStates).toEqual(["connecting", "failed"]);
      expect(connectConfigs).toEqual([server, server]);
    } finally {
      await toolset.dispose();
    }
  });

  test("connection failure leaves the late-added server persisted and reports failed", async () => {
    connectMode = "failed";
    const dir = tempDir("corbits-mcp-failure-");
    const path = join(dir, "settings.json");
    const persisted = await persistGlobalHTTPMCPServer(
      createGlobalSettingsWriter(path),
      "linear",
      "https://mcp.linear.app/mcp",
    );
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;

    const toolset = await makeToolset(
      resolveMcpServers([{ name: "exa", enabled: false }], undefined),
    );
    const states: { state: string; error?: string }[] = [];
    try {
      await toolset.connectMCPServer(persisted.server, {
        interactiveAuth: true,
        onStatus: (status) => states.push(status),
        onToolsChanged: () => undefined,
      });

      expect(states.map((status) => status.state)).toEqual(["connecting", "failed"]);
      expect(states[1]?.error).toContain("connection exploded");
      expect(toolset.hasMCPServer("linear")).toBe(false);
      expect(await Bun.file(path).json()).toMatchObject({
        mcpServers: [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }],
      });
      expect(
        await persistGlobalHTTPMCPServer(
          createGlobalSettingsWriter(path),
          "linear",
          "https://mcp.linear.app/mcp",
          "none",
          toolset.hasMCPServer,
        ),
      ).toEqual({ ok: false, reason: "duplicate" });

      connectMode = "success";
      const retryStates: string[] = [];
      await toolset.connectMCPServer(persisted.server, {
        interactiveAuth: true,
        onStatus: (status) => retryStates.push(status.state),
        onToolsChanged: () => undefined,
      });
      expect(retryStates).toEqual(["connecting", "connected"]);
      expect(toolset.hasMCPServer("linear")).toBe(true);
      expect(await Bun.file(path).json()).toMatchObject({
        mcpServers: [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }],
      });
    } finally {
      await toolset.dispose();
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

  test("disconnect after connect drops mcp__exa tools and restores native web_fetch", async () => {
    const toolset = await makeToolset();
    try {
      await connect(toolset);
      expect(toolset.dynamicRunner.currentDefinitions().map((d) => d.name)).toContain(
        "mcp__exa__web_search_exa",
      );

      await toolset.disconnectMCPServer("exa", {
        interactiveAuth: false,
        onStatus: () => undefined,
        onToolsChanged: () => undefined,
      });

      const names = toolset.dynamicRunner.currentDefinitions().map((d) => d.name);
      expect(names).toContain("web_fetch");
      expect(names.some((name) => name.startsWith("mcp__exa__"))).toBe(false);

      calls.length = 0;
      const result = await runTool(toolset, "web_fetch", { url: "http://127.0.0.1:1", timeout: 1 });
      expect(calls).toHaveLength(0);
      expect(String(result.content)).not.toBe("exa fetch result");
      expect(String(result.content)).not.toContain("Exa MCP");
    } finally {
      await toolset.dispose();
    }
  });

  test("disconnect before connect swaps waiters to native and re-enable remounts the alias", async () => {
    const toolset = await makeToolset();
    try {
      await toolset.disconnectMCPServer("exa", {
        interactiveAuth: false,
        onStatus: () => undefined,
        onToolsChanged: () => undefined,
      });

      calls.length = 0;
      const native = await runTool(toolset, "web_fetch", { url: "http://127.0.0.1:1", timeout: 1 });
      expect(calls).toHaveLength(0);
      expect(String(native.content)).not.toContain("Exa MCP");
      expect(toolset.hasMCPServer("exa")).toBe(false);

      const connectsBefore = connectConfigs.length;
      await toolset.connectMCPServer(createExaMCPServerConfig(), {
        interactiveAuth: false,
        onStatus: () => undefined,
        onToolsChanged: () => undefined,
      });
      expect(connectConfigs.length).toBe(connectsBefore + 1);
      expect(toolset.hasMCPServer("exa")).toBe(true);
      expect(toolset.dynamicRunner.currentDefinitions().map((d) => d.name)).toContain(
        "mcp__exa__web_search_exa",
      );

      calls.length = 0;
      const aliased = await runTool(toolset, "web_fetch", { url: "https://example.com" });
      expect(aliased).toEqual({ callId: "call-web_fetch", content: "exa fetch result" });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        toolName: "web_fetch_exa",
        args: { urls: ["https://example.com"] },
      });
    } finally {
      await toolset.dispose();
    }
  });

  test("cold-enable of builtin Exa remounts the web_fetch alias", async () => {
    const toolset = await makeToolset(
      resolveMcpServers([{ name: "exa", enabled: false }], undefined),
    );
    try {
      calls.length = 0;
      const native = await runTool(toolset, "web_fetch", { url: "http://127.0.0.1:1", timeout: 1 });
      expect(calls).toHaveLength(0);
      expect(String(native.content)).not.toContain("Exa MCP");

      await toolset.connectMCPServer(createExaMCPServerConfig(), {
        interactiveAuth: false,
        onStatus: () => undefined,
        onToolsChanged: () => undefined,
      });
      expect(toolset.hasMCPServer("exa")).toBe(true);
      expect(toolset.dynamicRunner.currentDefinitions().map((d) => d.name)).toContain(
        "mcp__exa__web_search_exa",
      );

      calls.length = 0;
      const aliased = await runTool(toolset, "web_fetch", { url: "https://example.com" });
      expect(aliased).toEqual({ callId: "call-web_fetch", content: "exa fetch result" });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        toolName: "web_fetch_exa",
        args: { urls: ["https://example.com"] },
      });
    } finally {
      await toolset.dispose();
    }
  });

  test("re-enable remounts the alias with a fresh connection", async () => {
    const toolset = await makeToolset();
    try {
      await connect(toolset);
      const firstConnects = connectConfigs.length;
      await toolset.disconnectMCPServer("exa", {
        interactiveAuth: false,
        onStatus: () => undefined,
        onToolsChanged: () => undefined,
      });
      await toolset.connectMCPServer(createExaMCPServerConfig(), {
        interactiveAuth: false,
        onStatus: () => undefined,
        onToolsChanged: () => undefined,
      });
      expect(connectConfigs.length).toBe(firstConnects + 1);
      expect(toolset.dynamicRunner.currentDefinitions().map((d) => d.name)).toContain(
        "mcp__exa__web_search_exa",
      );

      calls.length = 0;
      const result = await runTool(toolset, "web_fetch", { url: "https://example.com" });
      expect(result).toEqual({ callId: "call-web_fetch", content: "exa fetch result" });
      expect(calls[0]?.toolName).toBe("web_fetch_exa");
    } finally {
      await toolset.dispose();
    }
  });

  test("overlapping disconnect and connect remounts Exa-backed web_fetch", async () => {
    const toolset = await makeToolset();
    try {
      await connect(toolset);
      const firstConnects = connectConfigs.length;

      const disconnecting = toolset.disconnectMCPServer("exa", {
        interactiveAuth: false,
        onStatus: () => undefined,
        onToolsChanged: () => undefined,
      });
      const connecting = toolset.connectMCPServer(createExaMCPServerConfig(), {
        interactiveAuth: false,
        onStatus: () => undefined,
        onToolsChanged: () => undefined,
      });
      await Promise.all([disconnecting, connecting]);

      expect(toolset.hasMCPServer("exa")).toBe(true);
      expect(toolset.dynamicRunner.currentDefinitions().map((d) => d.name)).toContain(
        "mcp__exa__web_search_exa",
      );
      expect(closedGenerations).toContain(1);
      expect(connectConfigs.length).toBe(firstConnects + 1);

      calls.length = 0;
      const result = await runTool(toolset, "web_fetch", { url: "https://example.com" });
      expect(result).toEqual({ callId: "call-web_fetch", content: "exa fetch result" });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        toolName: "web_fetch_exa",
        args: { urls: ["https://example.com"] },
      });
    } finally {
      await toolset.dispose();
    }
  });
});
