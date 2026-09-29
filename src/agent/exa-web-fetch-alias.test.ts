import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@intx/types/runtime";
import { stringTool, type AgentTool } from "@intx/agent";
import {
  installMcpConnectMock,
  linearHttpMcpServer,
  mcpTestPermissionGate,
} from "../testkit/mcp-connect-mock.js";
import { createExaMCPServerConfig } from "../mcp/exa.js";
import {
  createGlobalSettingsWriter,
  persistGlobalHTTPMCPServer,
} from "../mcp/add-server.js";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const exaFetchTools = [
  {
    name: "web_fetch_exa",
    description: "Fetch",
    inputSchema: {},
  },
  {
    name: "web_search_exa",
    description: "Search",
    inputSchema: {},
  },
];
const exaSearchOnlyTools = [
  {
    name: "web_search_exa",
    description: "Search",
    inputSchema: {},
  },
];

const mock = await installMcpConnectMock(
  import.meta.resolve("../mcp/client.js"),
  {
    failureError: "connection exploded",
    toolCallResult: "exa fetch result",
    resolveTools: (mode) =>
      mode === "missing-fetch" ? exaSearchOnlyTools : exaFetchTools,
  },
);

const { createAgentToolset } = await import("./tools.js");
const { resolveMcpServers } = await import("../config/index.js");
const { coreSubAgentWebTools } = await import("../subagent/run.js");

function permissionGate() {
  return mcpTestPermissionGate();
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

async function connect(
  toolset: Awaited<ReturnType<typeof createAgentToolset>>,
) {
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
  return toolset.dynamicRunner.run(
    { id: `call-${name}`, name, arguments: args },
    signal,
  );
}

beforeEach(() => {
  mock.reset();
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
      const initialNames = toolset.dynamicRunner
        .currentDefinitions()
        .map((d) => d.name);
      expect(initialNames).toContain("web_fetch");
      expect(initialNames).not.toContain("mcp__exa__web_fetch_exa");

      await connect(toolset);
      const connectedNames = toolset.dynamicRunner
        .currentDefinitions()
        .map((d) => d.name);
      expect(connectedNames).toContain("web_fetch");
      expect(connectedNames).toContain("mcp__exa__web_search_exa");
      expect(connectedNames).not.toContain("mcp__exa__web_fetch_exa");
      expect(mock.connectConfigs).toHaveLength(1);
    } finally {
      await toolset.dispose();
    }
  });

  test("disabled and custom Exa use ordinary native/raw behavior", async () => {
    const disabled = await makeToolset(
      resolveMcpServers([{ name: "exa", enabled: false }], undefined),
    );
    try {
      expect(
        disabled.dynamicRunner.currentDefinitions().map((d) => d.name),
      ).toContain("web_fetch");
      await connect(disabled);
      expect(mock.connectConfigs).toHaveLength(0);
    } finally {
      await disabled.dispose();
    }

    mock.connectConfigs = [];
    const custom = await makeToolset(
      resolveMcpServers(
        [{ name: "exa", type: "http", url: "https://example.test/mcp" }],
        undefined,
      ),
    );
    try {
      await connect(custom);
      const names = custom.dynamicRunner
        .currentDefinitions()
        .map((d) => d.name);
      expect(names).toContain("web_fetch");
      expect(names).toContain("mcp__exa__web_fetch_exa");
      expect(mock.connectConfigs).toEqual([
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

      expect(result).toEqual({
        callId: "call-web_fetch",
        content: "exa fetch result",
      });
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]).toMatchObject({
        toolName: "web_fetch_exa",
        args: { urls: ["https://example.com"] },
      });
      expect(mock.calls[0]?.args).not.toHaveProperty("url");
      expect(mock.calls[0]?.args).not.toHaveProperty("format");
      expect(mock.calls[0]?.args).not.toHaveProperty("timeout");
      expect(mock.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await toolset.dispose();
    }
  });

  test("canonical web_fetch rejects non-http URLs before invoking Exa MCP", async () => {
    const toolset = await makeToolset();
    try {
      await connect(toolset);
      const result = await runTool(toolset, "web_fetch", {
        url: "ftp://example.com/file",
      });

      expect(result).not.toHaveProperty("isError");
      expect(result.content).toBe(
        'Error: Unsupported protocol "ftp:"; only http and https are allowed.',
      );
      expect(mock.calls).toHaveLength(0);
    } finally {
      await toolset.dispose();
    }
  });

  test("canonical web_fetch returns explicit Exa MCP errors without native fallback", async () => {
    mock.mode = "missing-fetch";
    const toolset = await makeToolset();
    try {
      await connect(toolset);
      const result = await runTool(toolset, "web_fetch", {
        url: "https://example.com",
      });
      expect(result).not.toHaveProperty("isError");
      expect(result.content).toContain("Exa MCP");
      expect(result.content).toContain("web_fetch_exa");
      expect(mock.calls).toHaveLength(0);
    } finally {
      await toolset.dispose();
    }

    mock.mode = "failure";
    const failed = await makeToolset();
    try {
      await connect(failed);
      const result = await runTool(failed, "web_fetch", {
        url: "https://example.com",
      });
      expect(result).not.toHaveProperty("isError");
      expect(result.content).toContain("Exa MCP");
      expect(result.content).toContain("connection exploded");
      expect(mock.calls).toHaveLength(0);
    } finally {
      await failed.dispose();
    }
  });

  test("single-server connection deduplicates and hands OAuth status through", async () => {
    mock.mode = "auth";
    const toolset = await makeToolset(
      resolveMcpServers([{ name: "exa", enabled: false }], undefined),
    );
    const states: { state: string; url?: string }[] = [];
    const callbacks = {
      interactiveAuth: true,
      onStatus: (status: { state: string; url?: string }) =>
        states.push(status),
      onToolsChanged: () => undefined,
    };
    const server = linearHttpMcpServer;
    try {
      await Promise.all([
        toolset.connectMCPServer(server, callbacks),
        toolset.connectMCPServer(server, callbacks),
      ]);
      await toolset.connectMCPServer(server, callbacks);

      expect(mock.connectConfigs).toEqual([server]);
      expect(states.map((status) => status.state)).toEqual([
        "connecting",
        "needs-auth",
        "connected",
      ]);
      expect(states[1]?.url).toBe("https://auth.test/authorize");
      expect(mock.connectOptions[0]?.onAuthURL).toBeDefined();
    } finally {
      await toolset.dispose();
    }
  });

  test("dispose invalidates an in-flight connection and closes its late client", async () => {
    mock.mode = "deferred";
    const toolset = await makeToolset(
      resolveMcpServers([{ name: "exa", enabled: false }], undefined),
    );
    const states: string[] = [];
    const connection = toolset.connectMCPServer(linearHttpMcpServer, {
      interactiveAuth: true,
      onStatus: (status) => states.push(status.state),
      onToolsChanged: () => undefined,
    });
    await Promise.resolve();

    let disposed = false;
    const disposal = toolset.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    mock.releaseDeferredConnect?.();
    await Promise.all([connection, disposal]);

    expect(states).toEqual(["connecting"]);
    expect(mock.closedClients).toEqual(["linear"]);
    expect(
      toolset.dynamicRunner
        .currentDefinitions()
        .some((tool) => tool.name.includes("linear")),
    ).toBe(false);
  });

  test("dispose aborts blocked interactive auth and closes its resources", async () => {
    mock.blockOnAuth = true;
    const toolset = await makeToolset(
      resolveMcpServers([{ name: "exa", enabled: false }], undefined),
    );
    const callerAbort = new AbortController();
    const states: string[] = [];
    const connection = toolset.connectMCPServer(
      linearHttpMcpServer,
      {
        interactiveAuth: true,
        onStatus: (status) => states.push(status.state),
        onToolsChanged: () => undefined,
      },
      callerAbort.signal,
    );
    while (mock.connectOptions.length === 0) await Promise.resolve();

    const ownedSignal = mock.connectOptions[0]?.signal;
    expect(ownedSignal).toBeDefined();
    expect(ownedSignal).not.toBe(callerAbort.signal);
    const disposal = toolset.dispose();
    expect(toolset.dispose()).toBe(disposal);
    await Promise.resolve();
    expect(ownedSignal?.aborted).toBe(true);
    expect(callerAbort.signal.aborted).toBe(false);
    await Promise.all([connection, disposal]);

    expect(mock.authWaitAborts).toBe(1);
    expect(mock.authResourceCloses).toBe(1);
    expect(states).toEqual(["connecting", "needs-auth"]);
    expect(
      toolset.dynamicRunner
        .currentDefinitions()
        .some((tool) => tool.name.includes("linear")),
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

    mock.mode = "deferred";
    const inFlight = await makeToolset();
    const inFlightPath = join(tempDir("corbits-mcp-active-"), "settings.json");
    const startup = connect(inFlight);
    while (mock.releaseDeferredConnect === undefined) await Promise.resolve();
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
      mock.releaseDeferredConnect?.();
      await startup;
      await inFlight.dispose();
    }
  });

  test("failed implicit Exa is not active and retries without a second persist", async () => {
    mock.mode = "failure";
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

      mock.mode = "success";
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
      await toolset.connectMCPServer(linearHttpMcpServer, {
        interactiveAuth: true,
        onStatus: (status) => states.push(status),
        onToolsChanged: () => undefined,
      });

      expect(states.map((status) => status.state)).toEqual([
        "connecting",
        "failed",
      ]);
      expect(states[1]?.error).toContain("registration exploded");
      expect(mock.closedClients).toEqual(["linear"]);
    } finally {
      await toolset.dispose();
    }
  });

  test("rejected single-server connection reports failed without registration or client leaks", async () => {
    mock.mode = "rejected";
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
    const server = linearHttpMcpServer;
    const states: { state: string; error?: string }[] = [];
    try {
      await toolset.connectMCPServer(server, {
        interactiveAuth: true,
        onStatus: (status) => states.push(status),
        onToolsChanged: () => undefined,
      });

      expect(states.map((status) => status.state)).toEqual([
        "connecting",
        "failed",
      ]);
      expect(states[1]?.error).toContain("transport setup exploded");
      expect(registrations).toBe(0);
      expect(unregistrations).toBe(0);
      expect(mock.closedClients).toEqual([]);
      expect(
        toolset.dynamicRunner
          .currentDefinitions()
          .some((tool) => tool.name.includes("linear")),
      ).toBe(false);
      expect(toolset.hasMCPServer("linear")).toBe(false);

      mock.mode = "failure";
      const retryStates: string[] = [];
      await toolset.connectMCPServer(server, {
        interactiveAuth: true,
        onStatus: (status) => retryStates.push(status.state),
        onToolsChanged: () => undefined,
      });
      expect(retryStates).toEqual(["connecting", "failed"]);
      expect(mock.connectConfigs).toEqual([server, server]);
    } finally {
      await toolset.dispose();
    }
  });

  test("connection failure leaves the late-added server persisted and reports failed", async () => {
    mock.mode = "failure";
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

      expect(states.map((status) => status.state)).toEqual([
        "connecting",
        "failed",
      ]);
      expect(states[1]?.error).toContain("connection exploded");
      expect(toolset.hasMCPServer("linear")).toBe(false);
      expect(await Bun.file(path).json()).toMatchObject({
        mcpServers: [linearHttpMcpServer],
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

      mock.mode = "success";
      const retryStates: string[] = [];
      await toolset.connectMCPServer(persisted.server, {
        interactiveAuth: true,
        onStatus: (status) => retryStates.push(status.state),
        onToolsChanged: () => undefined,
      });
      expect(retryStates).toEqual(["connecting", "connected"]);
      expect(toolset.hasMCPServer("linear")).toBe(true);
      expect(await Bun.file(path).json()).toMatchObject({
        mcpServers: [linearHttpMcpServer],
      });
    } finally {
      await toolset.dispose();
    }
  });

  test("child assembly keeps inherited canonical web_fetch and avoids duplicate native fetch", () => {
    const inherited: AgentTool[] = [
      stringTool({
        definition: {
          name: "web_fetch",
          description: "Inherited Exa fetch",
          inputSchema: {},
        },
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
      expect(
        toolset.dynamicRunner.currentDefinitions().map((d) => d.name),
      ).toContain("mcp__exa__web_search_exa");

      await toolset.disconnectMCPServer("exa", {
        interactiveAuth: false,
        onStatus: () => undefined,
        onToolsChanged: () => undefined,
      });

      const names = toolset.dynamicRunner
        .currentDefinitions()
        .map((d) => d.name);
      expect(names).toContain("web_fetch");
      expect(names.some((name) => name.startsWith("mcp__exa__"))).toBe(false);

      mock.calls.length = 0;
      const result = await runTool(toolset, "web_fetch", {
        url: "http://127.0.0.1:1",
        timeout: 1,
      });
      expect(mock.calls).toHaveLength(0);
      expect(String(result.content)).not.toBe("exa fetch result");
      expect(String(result.content)).not.toContain("Exa MCP");
    } finally {
      await toolset.dispose();
    }
  });

  test("absent builtin Exa keeps native web_fetch and enabling remounts the alias", async () => {
    const toolset = await makeToolset(
      resolveMcpServers([{ name: "exa", enabled: false }], undefined),
    );
    try {
      // Disconnecting a never-connected name is a no-op; waiters stay native.
      await toolset.disconnectMCPServer("exa", {
        interactiveAuth: false,
        onStatus: () => undefined,
        onToolsChanged: () => undefined,
      });

      mock.calls.length = 0;
      const native = await runTool(toolset, "web_fetch", {
        url: "http://127.0.0.1:1",
        timeout: 1,
      });
      expect(mock.calls).toHaveLength(0);
      expect(String(native.content)).not.toContain("Exa MCP");
      expect(toolset.hasMCPServer("exa")).toBe(false);

      const connectsBefore = mock.connectConfigs.length;
      await toolset.connectMCPServer(createExaMCPServerConfig(), {
        interactiveAuth: false,
        onStatus: () => undefined,
        onToolsChanged: () => undefined,
      });
      expect(mock.connectConfigs.length).toBe(connectsBefore + 1);
      expect(toolset.hasMCPServer("exa")).toBe(true);
      expect(
        toolset.dynamicRunner.currentDefinitions().map((d) => d.name),
      ).toContain("mcp__exa__web_search_exa");

      mock.calls.length = 0;
      const aliased = await runTool(toolset, "web_fetch", {
        url: "https://example.com",
      });
      expect(aliased).toEqual({
        callId: "call-web_fetch",
        content: "exa fetch result",
      });
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]).toMatchObject({
        toolName: "web_fetch_exa",
        args: { urls: ["https://example.com"] },
      });
    } finally {
      await toolset.dispose();
    }
  });

  test("overlapping disconnect and connect remounts Exa-backed web_fetch", async () => {
    const toolset = await makeToolset();
    try {
      await connect(toolset);
      const firstConnects = mock.connectConfigs.length;

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
      expect(
        toolset.dynamicRunner.currentDefinitions().map((d) => d.name),
      ).toContain("mcp__exa__web_search_exa");
      expect(mock.closedGenerations).toContain(1);
      expect(mock.connectConfigs.length).toBe(firstConnects + 1);

      mock.calls.length = 0;
      const result = await runTool(toolset, "web_fetch", {
        url: "https://example.com",
      });
      expect(result).toEqual({
        callId: "call-web_fetch",
        content: "exa fetch result",
      });
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]).toMatchObject({
        toolName: "web_fetch_exa",
        args: { urls: ["https://example.com"] },
      });
    } finally {
      await toolset.dispose();
    }
  });

  test("in-flight builtin Exa connect does not remount and fail web_fetch waiters", async () => {
    mock.mode = "deferred";
    const toolset = await makeToolset();
    const startup = connect(toolset);
    while (mock.releaseDeferredConnect === undefined) await Promise.resolve();
    try {
      const fetchPromise = runTool(toolset, "web_fetch", {
        url: "https://example.com",
      });
      await Promise.resolve();
      await Promise.resolve();

      const late = toolset.connectMCPServer(createExaMCPServerConfig(), {
        interactiveAuth: false,
        onStatus: () => undefined,
        onToolsChanged: () => undefined,
      });
      await Promise.resolve();
      await Promise.resolve();

      mock.releaseDeferredConnect?.();
      await Promise.all([startup, late]);

      const result = await fetchPromise;
      expect(String(result.content)).not.toContain("disconnected");
      expect(result).toEqual({
        callId: "call-web_fetch",
        content: "exa fetch result",
      });
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]).toMatchObject({
        toolName: "web_fetch_exa",
        args: { urls: ["https://example.com"] },
      });
    } finally {
      mock.releaseDeferredConnect?.();
      await toolset.dispose();
    }
  });
});
