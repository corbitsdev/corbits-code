import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withMockedModule } from "../../tests/helpers/mock-module.js";
import {
  createExaMCPServerConfig,
  type ResolvedMCPServerConfig,
} from "../mcp/exa.js";
import type { MCPConnectOptions, MCPTool } from "../mcp/client.js";
import { createPermissionGate } from "../permission/gate.js";
import type { MCPServerState } from "./tools.js";

const dirs: string[] = [];
const closedClients: string[] = [];
const closedGenerations: number[] = [];
let connectGeneration = 0;
let connectOptions: MCPConnectOptions[] = [];
let releaseDeferredConnect: (() => void) | undefined;
let connectMode: "success" | "deferred" | "auth-pending" | "failure" =
  "success";
// One-shot transient dial failures for reconnect tests; consumed by the mock
// before the connectMode branch so a fixed number of redials can fail first.
let failNextConnects = 0;
// Persistent redial failure message while connectMode is "failure".
let connectFailureError = "redial refused";
// When true the mock offers an auth URL (interactive needs-auth) before the
// connectMode branch runs, so a redial can pend on the operator.
let emitNeedsAuth = false;
// Reconnect tests repoint this to simulate a server whose tool set drifted
// between generations; the default matches the original static payload.
let connectedTools: MCPTool[] = [
  { name: "list", description: "List", inputSchema: {} },
];

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "corbits-mcp-disconnect-"));
  dirs.push(dir);
  return dir;
}

await withMockedModule(
  import.meta.resolve("../mcp/client.js"),
  (real: typeof import("../mcp/client.js")) => ({
    ...real,
    connectMCPServer: async (
      config: ResolvedMCPServerConfig,
      options: MCPConnectOptions = {},
    ) => {
      connectOptions.push(options);
      const generation = ++connectGeneration;
      if (emitNeedsAuth) {
        options.onAuthURL?.(config.name, "https://auth.example.test/approve");
      }
      if (failNextConnects > 0) {
        failNextConnects -= 1;
        return {
          ok: false as const,
          serverName: config.name,
          error: "redial refused",
        };
      }
      if (connectMode === "failure") {
        return {
          ok: false as const,
          serverName: config.name,
          error: connectFailureError,
        };
      }
      if (connectMode === "deferred") {
        await new Promise<void>((resolve) => {
          releaseDeferredConnect = resolve;
          const onAbort = (): void => resolve();
          if (options.signal?.aborted === true) onAbort();
          else
            options.signal?.addEventListener("abort", onAbort, { once: true });
        });
        if (options.signal?.aborted === true) {
          return {
            ok: false as const,
            serverName: config.name,
            error: "aborted",
          };
        }
      }
      if (connectMode === "auth-pending") {
        return {
          ok: false as const,
          serverName: config.name,
          error: "timed out waiting for the browser",
          authPending: true,
        };
      }
      return {
        ok: true as const,
        client: {
          serverName: config.name,
          tools: connectedTools,
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
  return createPermissionGate({
    approvals: [],
    interactive: false,
    skipPermissions: true,
    reactorGated: false,
  });
}

async function makeToolset() {
  return createAgentToolset({
    cwd: tempCwd(),
    permissionGate: permissionGate(),
    onOperatorGate: async () => ({ kind: "cancel" }),
    mcpServers: resolveMcpServers([{ name: "exa", enabled: false }], undefined),
  });
}

const acme = {
  name: "acme",
  type: "http" as const,
  url: "https://mcp.acme.test/mcp",
};
const lin = {
  name: "lin",
  type: "http" as const,
  url: "https://mcp.lin.test/mcp",
};
const linear = {
  name: "linear",
  type: "http" as const,
  url: "https://mcp.linear.test/mcp",
};
const customExa = {
  name: "exa",
  type: "http" as const,
  url: "https://custom.exa.test/mcp",
};

function callbacks(
  states: MCPServerState[],
  toolsChanged: number[] = [],
  interactiveAuth = false,
) {
  return {
    interactiveAuth,
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
  failNextConnects = 0;
  connectFailureError = "redial refused";
  emitNeedsAuth = false;
  connectedTools = [{ name: "list", description: "List", inputSchema: {} }];
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
      mcpServers: resolveMcpServers(
        [{ name: "exa", enabled: false }],
        undefined,
      ),
    });
    const states: MCPServerState[] = [];
    const toolsChanged: number[] = [];
    try {
      await toolset.connectMCPServer(acme, callbacks(states, toolsChanged));
      expect(
        toolset.dynamicRunner.currentDefinitions().map((d) => d.name),
      ).toContain("mcp__acme__list");
      expect(toolset.hasMCPServer("acme")).toBe(true);

      await toolset.disconnectMCPServer(
        "acme",
        callbacks(states, toolsChanged),
      );

      expect(
        toolset.dynamicRunner
          .currentDefinitions()
          .some((d) => d.name.startsWith("mcp__acme__")),
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

      expect(
        toolset.dynamicRunner.currentDefinitions().map((d) => d.name),
      ).toContain("mcp__acme__list");
      expect(toolset.hasMCPServer("acme")).toBe(true);
      expect(states.some((s) => s.state === "failed")).toBe(false);
    } finally {
      await toolset.dispose();
    }
  });

  test("reconnect after the server's tools drift swaps the mounted set", async () => {
    const toolset = await makeToolset();
    const states: MCPServerState[] = [];
    const announced: ReturnType<
      typeof toolset.dynamicRunner.currentDefinitions
    >[] = [];
    try {
      await toolset.connectMCPServer(acme, callbacks(states));
      const acmeNames = (
        defs: ReturnType<typeof toolset.dynamicRunner.currentDefinitions>,
      ) =>
        defs
          .map((d) => d.name)
          .filter((name) => name.startsWith("mcp__acme__"));
      expect(acmeNames(toolset.dynamicRunner.currentDefinitions())).toEqual([
        "mcp__acme__list",
      ]);

      // The server redeployed mid-session: same tool name, new schema, plus a
      // new tool. Reconnect must mount exactly the drifted set.
      connectedTools = [
        {
          name: "list",
          description: "List v2",
          inputSchema: { type: "object", required: ["q"] },
        },
        { name: "search", description: "Search", inputSchema: {} },
      ];
      await toolset.disconnectMCPServer("acme", callbacks(states));
      await toolset.connectMCPServer(acme, {
        ...callbacks(states),
        onToolsChanged: (definitions) => announced.push(definitions),
      });

      const names = acmeNames(toolset.dynamicRunner.currentDefinitions());
      expect(names).toEqual(["mcp__acme__list", "mcp__acme__search"]);

      const list = toolset.dynamicRunner
        .currentDefinitions()
        .find((d) => d.name === "mcp__acme__list");
      expect(list?.description).toBe("[acme] List v2");
      expect(list?.inputSchema).toEqual({ type: "object", required: ["q"] });

      // The stale generation's client was closed and the drift was announced.
      expect(closedGenerations).toContain(1);
      expect(acmeNames(announced.at(-1) ?? [])).toEqual([
        "mcp__acme__list",
        "mcp__acme__search",
      ]);
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
      const names = toolset.dynamicRunner
        .currentDefinitions()
        .map((d) => d.name);
      expect(names).toContain("mcp__lin__list");
      expect(names).toContain("mcp__linear__list");

      await toolset.disconnectMCPServer("lin", callbacks(states));

      const after = toolset.dynamicRunner
        .currentDefinitions()
        .map((d) => d.name);
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
      expect(
        toolset.dynamicRunner.currentDefinitions().map((d) => d.name),
      ).toContain("mcp__exa__list");

      await toolset.disconnectMCPServer("exa", callbacks(states));
      expect(
        toolset.dynamicRunner
          .currentDefinitions()
          .some((d) => d.name.startsWith("mcp__exa__")),
      ).toBe(false);

      await toolset.connectMCPServer(
        createExaMCPServerConfig(),
        callbacks(states),
      );
      expect(toolset.hasMCPServer("exa")).toBe(true);
      expect(
        toolset.dynamicRunner.currentDefinitions().map((d) => d.name),
      ).toContain("mcp__exa__list");
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

      const disconnecting = toolset.disconnectMCPServer(
        "acme",
        callbacks(states),
      );
      expect(toolset.hasMCPServer("acme")).toBe(true);
      await Promise.all([connecting, disconnecting]);

      expect(states.some((s) => s.state === "failed")).toBe(false);
      expect(states.map((s) => s.state)).toContain("disconnected");
      expect(
        toolset.dynamicRunner
          .currentDefinitions()
          .some((d) => d.name.startsWith("mcp__acme__")),
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
      await toolset.disconnectMCPServer(
        "ghost",
        callbacks(states, toolsChanged),
      );
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

      const disconnecting = toolset.disconnectMCPServer(
        "acme",
        callbacks(states),
      );
      const connecting = toolset.connectMCPServer(acme, callbacks(states));
      await Promise.all([disconnecting, connecting]);

      expect(toolset.hasMCPServer("acme")).toBe(true);
      expect(
        toolset.dynamicRunner.currentDefinitions().map((d) => d.name),
      ).toContain("mcp__acme__list");
      expect(states.some((s) => s.state === "failed")).toBe(false);
      expect(closedGenerations).toContain(1);
      expect(connectOptions).toHaveLength(2);
    } finally {
      await toolset.dispose();
    }
  });
});

describe("setMcpServersSource", () => {
  test("updates the live trust filter from fail-closed local to global", async () => {
    const toolset = await createAgentToolset({
      cwd: tempCwd(),
      permissionGate: permissionGate(),
      onOperatorGate: async () => ({ kind: "cancel" }),
      mcpServers: resolveMcpServers(
        [{ name: "exa", enabled: false }],
        undefined,
      ),
      mcpServersSource: "local",
    });
    const untrusted: MCPServerState[] = [];
    try {
      await toolset.connectMCPServer(acme, callbacks(untrusted));
      expect(untrusted.some((s) => s.state === "failed")).toBe(true);
      expect(untrusted.find((s) => s.state === "failed")?.error).toMatch(
        /Not trusted for this project/,
      );
      expect(toolset.hasMCPServer("acme")).toBe(false);
      expect(
        toolset.dynamicRunner
          .currentDefinitions()
          .some((d) => d.name.startsWith("mcp__acme__")),
      ).toBe(false);

      toolset.setMcpServersSource("global");
      const trusted: MCPServerState[] = [];
      await toolset.connectMCPServer(acme, callbacks(trusted));

      expect(toolset.hasMCPServer("acme")).toBe(true);
      expect(
        toolset.dynamicRunner.currentDefinitions().map((d) => d.name),
      ).toContain("mcp__acme__list");
      expect(trusted.some((s) => s.state === "connected")).toBe(true);
      expect(trusted.some((s) => s.state === "failed")).toBe(false);
    } finally {
      await toolset.dispose();
    }
  });

  test("an auth-pending connect result reaches onStatus marked as such", async () => {
    const toolset = await makeToolset();
    const states: MCPServerState[] = [];
    connectMode = "auth-pending";
    try {
      await toolset.connectMCPServer(acme, callbacks(states));
      const failed = states.filter((s) => s.state === "failed");
      expect(failed).toEqual([
        {
          name: "acme",
          state: "failed",
          error: "timed out waiting for the browser",
          authPending: true,
        },
      ]);
      expect(toolset.hasMCPServer("acme")).toBe(false);
    } finally {
      await toolset.dispose();
    }
  });
});

const { MCP_RECONNECTING_TOOL_ERROR, isDegradedMcpState } =
  await import("../mcp/plugin.js");
const { mcpNotice } = await import("../tui/runtime-notices.js");
const { mcpReconnectDelayMs } = await import("./tools.js");

// The mocked connectMCPServer records its options, so tests simulate a dead
// transport by invoking the onDisconnect hook the real client wires to
// transport.onclose.
function killTransport(): void {
  connectOptions.at(-1)?.onDisconnect?.();
}

function acmeToolNames(
  toolset: Awaited<ReturnType<typeof makeToolset>>,
): string[] {
  return toolset.dynamicRunner
    .currentDefinitions()
    .map((d) => d.name)
    .filter((name) => name.startsWith("mcp__acme__"));
}

async function flushMicrotasks(rounds = 100): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

async function advanceAndFlush(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await flushMicrotasks();
}

async function advanceUntil(
  done: () => boolean,
  stepMs = 250,
  maxSteps = 400,
): Promise<void> {
  for (let i = 0; i < maxSteps && !done(); i++) {
    await advanceAndFlush(stepMs);
  }
  if (!done()) throw new Error("timed out advancing fake timers");
}

describe("unintentional disconnect and automatic reconnect", () => {
  test("transport death emits reconnecting once and keeps tools mounted", async () => {
    const toolset = await makeToolset();
    const states: MCPServerState[] = [];
    try {
      await toolset.connectMCPServer(acme, callbacks(states));
      expect(connectOptions).toHaveLength(1);

      killTransport();
      killTransport();

      const reconnecting = states.filter((s) => s.state === "reconnecting");
      expect(reconnecting).toHaveLength(1);
      expect(reconnecting[0]).toEqual({
        name: "acme",
        state: "reconnecting",
        tools: ["list"],
        attempt: 1,
        error: expect.any(String),
      });
      // The dead generation is never re-announced as connected.
      expect(states.filter((s) => s.state === "connected")).toHaveLength(1);
      expect(acmeToolNames(toolset)).toEqual(["mcp__acme__list"]);
      expect(toolset.hasMCPServer("acme")).toBe(true);
      expect(reconnecting.map((s) => isDegradedMcpState(s))).toEqual([true]);
      const connected: MCPServerState = {
        name: "acme",
        state: "connected",
        tools: [],
      };
      expect(isDegradedMcpState(connected)).toBe(false);
    } finally {
      await toolset.dispose();
    }
  });

  test("degraded calls fail fast with the shared error and no redial", async () => {
    const toolset = await makeToolset();
    const states: MCPServerState[] = [];
    try {
      await toolset.connectMCPServer(acme, callbacks(states));
      killTransport();

      const result = await toolset.dynamicRunner.run(
        { id: "c1", name: "mcp__acme__list", arguments: {} },
        AbortSignal.timeout(5000),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toBe(MCP_RECONNECTING_TOOL_ERROR);
      expect(connectOptions).toHaveLength(1);
    } finally {
      await toolset.dispose();
    }
  });

  test("transient death auto-recovers and restores dispatch", async () => {
    const toolset = await makeToolset();
    const states: MCPServerState[] = [];
    jest.useFakeTimers();
    try {
      await toolset.connectMCPServer(acme, callbacks(states));
      killTransport();
      expect(states.at(-1)?.state).toBe("reconnecting");

      await advanceUntil(() =>
        states.some((s) => s.state === "connected" && states.indexOf(s) > 1),
      );
      expect(connectOptions).toHaveLength(2);
      expect(states.at(-1)).toEqual({
        name: "acme",
        state: "connected",
        tools: ["list"],
      });
      expect(acmeToolNames(toolset)).toEqual(["mcp__acme__list"]);

      const result = await toolset.dynamicRunner.run(
        { id: "c1", name: "mcp__acme__list", arguments: {} },
        new AbortController().signal,
      );
      expect(result).toEqual({ callId: "c1", content: "ok" });

      // A second kill starts a new generation with its own emission.
      killTransport();
      expect(states.filter((s) => s.state === "reconnecting")).toHaveLength(2);
    } finally {
      jest.useRealTimers();
      await toolset.dispose();
    }
  });

  test("transient redial failures keep the row reconnecting with a live attempt", async () => {
    const toolset = await makeToolset();
    const states: MCPServerState[] = [];
    jest.useFakeTimers();
    try {
      await toolset.connectMCPServer(acme, callbacks(states));
      killTransport();
      expect(states.at(-1)?.state).toBe("reconnecting");

      // Two redials fail transiently before the third succeeds.
      failNextConnects = 2;
      await advanceUntil(() =>
        states.some((s) => s.state === "connected" && states.indexOf(s) > 1),
      );
      expect(connectOptions).toHaveLength(4);

      const afterDeath = states.slice(2);
      expect(afterDeath.some((s) => s.state === "failed")).toBe(false);
      const reconnecting = afterDeath.filter((s) => s.state === "reconnecting");
      expect(reconnecting.map((s) => s.attempt)).toEqual([1, 2, 3]);
      expect(reconnecting.map((s) => s.error)).toEqual([
        "transport closed unexpectedly; retrying in the background",
        "redial refused",
        "redial refused",
      ]);
      expect(states.at(-1)).toEqual({
        name: "acme",
        state: "connected",
        tools: ["list"],
      });
      // No failed row means no row notice for the operator either.
      expect(afterDeath.every((s) => mcpNotice(s)?.kind !== "row")).toBe(true);
    } finally {
      jest.useRealTimers();
      await toolset.dispose();
    }
  });

  test("non-auth terminal redial failure stops after the first attempt", async () => {
    const toolset = await makeToolset();
    const states: MCPServerState[] = [];
    jest.useFakeTimers();
    try {
      await toolset.connectMCPServer(acme, callbacks(states));
      killTransport();
      connectMode = "failure";
      connectFailureError = "spawn acme ENOENT";

      await advanceUntil(() => states.some((s) => s.state === "failed"));
      // Exactly one redial ran; the loop stopped instead of retrying forever.
      expect(connectOptions).toHaveLength(2);
      expect(states.at(-1)).toEqual({
        name: "acme",
        state: "failed",
        error: "spawn acme ENOENT",
      });
      expect(acmeToolNames(toolset)).toEqual([]);
      expect(toolset.hasMCPServer("acme")).toBe(false);

      await advanceAndFlush(120_000);
      expect(connectOptions).toHaveLength(2);
    } finally {
      jest.useRealTimers();
      await toolset.dispose();
    }
  });

  test("stubs stay mounted across an interactive needs-auth pend", async () => {
    const toolset = await makeToolset();
    const states: MCPServerState[] = [];
    jest.useFakeTimers();
    try {
      await toolset.connectMCPServer(acme, callbacks(states, [], true));
      // The redial offers an auth URL, then pends on the operator.
      emitNeedsAuth = true;
      connectMode = "deferred";
      killTransport();
      await advanceUntil(() => states.some((s) => s.state === "needs-auth"));
      expect(connectOptions).toHaveLength(2);
      expect(states.some((s) => s.state === "failed")).toBe(false);

      // The row is bare-stubbed meanwhile: calls fail fast, never dispatch.
      const pendResult = await toolset.dynamicRunner.run(
        { id: "p1", name: "mcp__acme__list", arguments: {} },
        new AbortController().signal,
      );
      expect(pendResult.isError).toBe(true);
      expect(pendResult.content).toBe(MCP_RECONNECTING_TOOL_ERROR);

      // The operator authorizes; the live set mounts over the stubs.
      releaseDeferredConnect?.();
      await advanceUntil(() =>
        states.some((s) => s.state === "connected" && states.indexOf(s) > 1),
      );
      expect(states.at(-1)).toEqual({
        name: "acme",
        state: "connected",
        tools: ["list"],
      });
      expect(acmeToolNames(toolset)).toEqual(["mcp__acme__list"]);
      const liveResult = await toolset.dynamicRunner.run(
        { id: "p2", name: "mcp__acme__list", arguments: {} },
        new AbortController().signal,
      );
      expect(liveResult).toEqual({ callId: "p2", content: "ok" });
    } finally {
      jest.useRealTimers();
      await toolset.dispose();
    }
  });

  test("backoff delays are jittered and capped", () => {
    expect(mcpReconnectDelayMs(1, () => 1)).toBe(1000);
    expect(mcpReconnectDelayMs(2, () => 1)).toBe(2000);
    expect(mcpReconnectDelayMs(6, () => 1)).toBe(30_000);
    expect(mcpReconnectDelayMs(100, () => 1)).toBe(30_000);
    expect(mcpReconnectDelayMs(1, () => 0)).toBe(0);
    const sample = mcpReconnectDelayMs(1, () => 0.5);
    expect(sample).toBe(500);
  });

  test("disable during backoff stops all redials", async () => {
    const toolset = await makeToolset();
    const states: MCPServerState[] = [];
    jest.useFakeTimers();
    try {
      await toolset.connectMCPServer(acme, callbacks(states));
      killTransport();
      expect(states.at(-1)?.state).toBe("reconnecting");

      await toolset.disconnectMCPServer("acme", callbacks(states));
      await advanceAndFlush(60_000);

      expect(connectOptions).toHaveLength(1);
      expect(states.at(-1)).toEqual({ name: "acme", state: "disconnected" });
      expect(acmeToolNames(toolset)).toEqual([]);
      expect(toolset.hasMCPServer("acme")).toBe(false);
    } finally {
      jest.useRealTimers();
      await toolset.dispose();
    }
  });

  test("auth-pending failure stops the loop and drops the stubs", async () => {
    const toolset = await makeToolset();
    const states: MCPServerState[] = [];
    jest.useFakeTimers();
    try {
      await toolset.connectMCPServer(acme, callbacks(states));
      killTransport();
      connectMode = "auth-pending";

      await advanceUntil(() =>
        states.some(
          (s) =>
            s.state === "failed" &&
            "authPending" in s &&
            s.authPending === true,
        ),
      );
      expect(connectOptions).toHaveLength(2);
      expect(states.at(-1)?.state).toBe("failed");
      expect(acmeToolNames(toolset)).toEqual([]);
      expect(toolset.hasMCPServer("acme")).toBe(false);

      await advanceAndFlush(120_000);
      expect(connectOptions).toHaveLength(2);
    } finally {
      jest.useRealTimers();
      await toolset.dispose();
    }
  });

  test("manual retry on a reconnecting row single-dials", async () => {
    const toolset = await makeToolset();
    const states: MCPServerState[] = [];
    jest.useFakeTimers();
    try {
      await toolset.connectMCPServer(acme, callbacks(states));
      killTransport();
      expect(states.at(-1)?.state).toBe("reconnecting");

      await toolset.retryMCPServer(acme, callbacks(states));
      expect(connectOptions).toHaveLength(2);
      expect(states.at(-1)).toEqual({
        name: "acme",
        state: "connected",
        tools: ["list"],
      });
      expect(acmeToolNames(toolset)).toEqual(["mcp__acme__list"]);

      await advanceAndFlush(120_000);
      expect(connectOptions).toHaveLength(2);
      expect(closedGenerations).toContain(1);
    } finally {
      jest.useRealTimers();
      await toolset.dispose();
    }
  });

  test("manual retry on a terminal-failed row single-dials", async () => {
    const toolset = await makeToolset();
    const states: MCPServerState[] = [];
    jest.useFakeTimers();
    try {
      await toolset.connectMCPServer(acme, callbacks(states));
      killTransport();
      connectMode = "auth-pending";
      await advanceUntil(() => states.some((s) => s.state === "failed"));
      expect(connectOptions).toHaveLength(2);

      connectMode = "success";
      await toolset.retryMCPServer(acme, callbacks(states));
      expect(connectOptions).toHaveLength(3);
      expect(states.at(-1)).toEqual({
        name: "acme",
        state: "connected",
        tools: ["list"],
      });
      expect(acmeToolNames(toolset)).toEqual(["mcp__acme__list"]);

      await advanceAndFlush(120_000);
      expect(connectOptions).toHaveLength(3);
    } finally {
      jest.useRealTimers();
      await toolset.dispose();
    }
  });

  test("retry during an in-flight attempt settles the stale dial without mounting", async () => {
    const toolset = await makeToolset();
    const states: MCPServerState[] = [];
    jest.useFakeTimers();
    try {
      await toolset.connectMCPServer(acme, callbacks(states));
      expect(connectOptions).toHaveLength(1);
      connectMode = "deferred";
      killTransport();
      expect(states.at(-1)?.state).toBe("reconnecting");
      await advanceAndFlush(1500);
      // The backoff fired and the replacement dial is hanging in the mock.
      expect(connectOptions).toHaveLength(2);

      const retrying = toolset.retryMCPServer(acme, callbacks(states));
      await flushMicrotasks();
      // The stale attempt was aborted; release the retry's own dial.
      releaseDeferredConnect?.();
      await retrying;

      expect(connectOptions).toHaveLength(3);
      expect(states.at(-1)).toEqual({
        name: "acme",
        state: "connected",
        tools: ["list"],
      });
      expect(acmeToolNames(toolset)).toEqual(["mcp__acme__list"]);
      expect(states.some((s) => s.state === "failed")).toBe(false);

      await advanceAndFlush(120_000);
      expect(connectOptions).toHaveLength(3);
    } finally {
      releaseDeferredConnect?.();
      jest.useRealTimers();
      await toolset.dispose();
    }
  });
});
