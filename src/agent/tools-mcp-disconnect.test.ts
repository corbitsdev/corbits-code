import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withMockedModule } from "../../tests/helpers/mock-module.js";
import { createExaMCPServerConfig, type ResolvedMCPServerConfig } from "../mcp/exa.js";
import type { MCPConnectOptions } from "../mcp/client.js";
import { createPermissionGate } from "../permission/gate.js";
import type { MCPServerState } from "./tools.js";

const dirs: string[] = [];
const closedClients: string[] = [];
const closedGenerations: number[] = [];
let connectGeneration = 0;
let connectOptions: MCPConnectOptions[] = [];
let releaseDeferredConnect: (() => void) | undefined;
let connectMode: "success" | "deferred" = "success";

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "corbits-mcp-disconnect-"));
  dirs.push(dir);
  return dir;
}

await withMockedModule(
  import.meta.resolve("../mcp/client.js"),
  (real: typeof import("../mcp/client.js")) => ({
    ...real,
    connectMCPServer: async (config: ResolvedMCPServerConfig, options: MCPConnectOptions = {}) => {
      connectOptions.push(options);
      const generation = ++connectGeneration;
      if (connectMode === "deferred") {
        await new Promise<void>((resolve) => {
          releaseDeferredConnect = resolve;
          const onAbort = (): void => resolve();
          if (options.signal?.aborted === true) onAbort();
          else options.signal?.addEventListener("abort", onAbort, { once: true });
        });
        if (options.signal?.aborted === true) {
          return { ok: false as const, serverName: config.name, error: "aborted" };
        }
      }
      return {
        ok: true as const,
        client: {
          serverName: config.name,
          tools: [{ name: "list", description: "List", inputSchema: {} }],
          call: async () => "ok",
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

function permissionGate() {
  return createPermissionGate({ approvals: [], interactive: false, skipPermissions: true });
}

async function makeToolset() {
  return createAgentToolset({
    cwd: tempCwd(),
    permissionGate: permissionGate(),
    onOperatorGate: async () => ({ kind: "cancel" }),
    mcpServers: resolveMcpServers([{ name: "exa", enabled: false }], undefined),
  });
}

const acme = { name: "acme", type: "http" as const, url: "https://mcp.acme.test/mcp" };
const lin = { name: "lin", type: "http" as const, url: "https://mcp.lin.test/mcp" };
const linear = { name: "linear", type: "http" as const, url: "https://mcp.linear.test/mcp" };
const customExa = { name: "exa", type: "http" as const, url: "https://custom.exa.test/mcp" };

function callbacks(states: MCPServerState[], toolsChanged: number[] = []) {
  return {
    interactiveAuth: false,
    onStatus: (state: MCPServerState) => states.push(state),
    onToolsChanged: () => {
      toolsChanged.push(1);
    },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  closedClients.length = 0;
  closedGenerations.length = 0;
  connectGeneration = 0;
  connectOptions = [];
  releaseDeferredConnect = undefined;
  connectMode = "success";
});

async function waitForConnectStart(timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (connectOptions.length === 0) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for MCP connect to start");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("disconnectMCPServer", () => {
  test("drops tools, unregisters, closes the client, and emits disconnected", async () => {
    const gate = permissionGate();
    let unregistrations = 0;
    const inner = gate.unregisterMcpServer.bind(gate);
    gate.unregisterMcpServer = (name) => {
      unregistrations += 1;
      inner(name);
    };
    const toolset = await createAgentToolset({
      cwd: tempCwd(),
      permissionGate: gate,
      onOperatorGate: async () => ({ kind: "cancel" }),
      mcpServers: resolveMcpServers([{ name: "exa", enabled: false }], undefined),
    });
    const states: MCPServerState[] = [];
    const toolsChanged: number[] = [];
    try {
      await toolset.connectMCPServer(acme, callbacks(states, toolsChanged));
      expect(toolset.dynamicRunner.currentDefinitions().map((d) => d.name)).toContain(
        "mcp__acme__list",
      );
      expect(toolset.hasMCPServer("acme")).toBe(true);

      await toolset.disconnectMCPServer("acme", callbacks(states, toolsChanged));

      expect(
        toolset.dynamicRunner.currentDefinitions().some((d) => d.name.startsWith("mcp__acme__")),
      ).toBe(false);
      expect(unregistrations).toBeGreaterThan(0);
      expect(closedClients).toEqual(["acme"]);
      expect(toolset.hasMCPServer("acme")).toBe(false);
      expect(states.map((s) => s.state)).toContain("disconnected");
      expect(states.some((s) => s.state === "failed")).toBe(false);
      expect(toolsChanged.length).toBeGreaterThan(1);
    } finally {
      await toolset.dispose();
    }
  });

  test("re-enable round-trips without DuplicateToolError", async () => {
    const toolset = await makeToolset();
    const states: MCPServerState[] = [];
    try {
      await toolset.connectMCPServer(acme, callbacks(states));
      await toolset.disconnectMCPServer("acme", callbacks(states));
      await toolset.connectMCPServer(acme, callbacks(states));

      expect(toolset.dynamicRunner.currentDefinitions().map((d) => d.name)).toContain(
        "mcp__acme__list",
      );
      expect(toolset.hasMCPServer("acme")).toBe(true);
      expect(states.some((s) => s.state === "failed")).toBe(false);
    } finally {
      await toolset.dispose();
    }
  });

  test("disconnecting lin does not drop linear tools", async () => {
    const toolset = await makeToolset();
    const states: MCPServerState[] = [];
    try {
      await toolset.connectMCPServer(lin, callbacks(states));
      await toolset.connectMCPServer(linear, callbacks(states));
      const names = toolset.dynamicRunner.currentDefinitions().map((d) => d.name);
      expect(names).toContain("mcp__lin__list");
      expect(names).toContain("mcp__linear__list");

      await toolset.disconnectMCPServer("lin", callbacks(states));

      const after = toolset.dynamicRunner.currentDefinitions().map((d) => d.name);
      expect(after).not.toContain("mcp__lin__list");
      expect(after).toContain("mcp__linear__list");
      expect(toolset.hasMCPServer("linear")).toBe(true);
      expect(toolset.hasMCPServer("lin")).toBe(false);
    } finally {
      await toolset.dispose();
    }
  });

  test("disconnect of custom exa then connect of builtin remounts tools", async () => {
    const toolset = await makeToolset();
    const states: MCPServerState[] = [];
    try {
      await toolset.connectMCPServer(customExa, callbacks(states));
      expect(toolset.dynamicRunner.currentDefinitions().map((d) => d.name)).toContain(
        "mcp__exa__list",
      );

      await toolset.disconnectMCPServer("exa", callbacks(states));
      expect(
        toolset.dynamicRunner.currentDefinitions().some((d) => d.name.startsWith("mcp__exa__")),
      ).toBe(false);

      await toolset.connectMCPServer(createExaMCPServerConfig(), callbacks(states));
      expect(toolset.hasMCPServer("exa")).toBe(true);
      expect(toolset.dynamicRunner.currentDefinitions().map((d) => d.name)).toContain(
        "mcp__exa__list",
      );
    } finally {
      await toolset.dispose();
    }
  });

  test("disable during in-flight aborts without failed status or tools", async () => {
    connectMode = "deferred";
    const toolset = await makeToolset();
    const states: MCPServerState[] = [];
    try {
      const connecting = toolset.connectMCPServer(acme, callbacks(states));
      await waitForConnectStart();
      expect(toolset.hasMCPServer("acme")).toBe(true);

      const disconnecting = toolset.disconnectMCPServer("acme", callbacks(states));
      expect(toolset.hasMCPServer("acme")).toBe(true);
      await Promise.all([connecting, disconnecting]);

      expect(states.some((s) => s.state === "failed")).toBe(false);
      expect(states.map((s) => s.state)).toContain("disconnected");
      expect(
        toolset.dynamicRunner.currentDefinitions().some((d) => d.name.startsWith("mcp__acme__")),
      ).toBe(false);
      expect(toolset.hasMCPServer("acme")).toBe(false);
    } finally {
      releaseDeferredConnect?.();
      await toolset.dispose();
    }
  });

  test("disconnect of a never-connected name is success and still emits", async () => {
    const toolset = await makeToolset();
    const states: MCPServerState[] = [];
    const toolsChanged: number[] = [];
    try {
      expect(toolset.hasMCPServer("ghost")).toBe(false);
      await toolset.disconnectMCPServer("ghost", callbacks(states, toolsChanged));
      expect(toolset.hasMCPServer("ghost")).toBe(false);
      expect(states).toEqual([{ name: "ghost", state: "disconnected" }]);
      expect(toolsChanged).toHaveLength(1);
    } finally {
      await toolset.dispose();
    }
  });

  test("overlapping disconnect and connect tears down then reconnects", async () => {
    const toolset = await makeToolset();
    const states: MCPServerState[] = [];
    try {
      await toolset.connectMCPServer(acme, callbacks(states));
      expect(connectOptions).toHaveLength(1);

      const disconnecting = toolset.disconnectMCPServer("acme", callbacks(states));
      const connecting = toolset.connectMCPServer(acme, callbacks(states));
      await Promise.all([disconnecting, connecting]);

      expect(toolset.hasMCPServer("acme")).toBe(true);
      expect(toolset.dynamicRunner.currentDefinitions().map((d) => d.name)).toContain(
        "mcp__acme__list",
      );
      expect(states.some((s) => s.state === "failed")).toBe(false);
      expect(closedGenerations).toContain(1);
      expect(connectOptions).toHaveLength(2);
    } finally {
      await toolset.dispose();
    }
  });
});
