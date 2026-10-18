import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installMcpConnectMock,
  mcpTestPermissionGate,
} from "../../../testkit/mcp-connect-mock.js";
import type { MCPServerState } from "../../agent/tools.js";
import { runTuiMcpDial } from "./mcp-connect.js";

const dirs: string[] = [];

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "corbits-tui-mcp-dial-"));
  dirs.push(dir);
  return dir;
}

const mock = await installMcpConnectMock(
  import.meta.resolve("../../mcp/client.js"),
  {
    initialTools: [{ name: "list", description: "List", inputSchema: {} }],
    abortableDeferred: true,
    teardownOnAbort: true,
  },
);

const { createAgentToolset } = await import("../../agent/tools.js");

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
const stuck = {
  name: "stuck",
  type: "stdio" as const,
  command: "stuck-mcp",
};

function callbacks(
  states: MCPServerState[],
  browserAuthOutlivesDialAbort = false,
) {
  return {
    interactiveAuth: true,
    ...(browserAuthOutlivesDialAbort
      ? { browserAuthOutlivesDialAbort: true as const }
      : {}),
    onStatus: (state: MCPServerState) => {
      states.push(state);
    },
    onToolsChanged: () => undefined,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  mock.reset();
});

describe("TUI MCP dial timeout", () => {
  test("a hung dial fails, the live sibling stays connected, and resume runs", async () => {
    mock.hangNames.add("lin");
    const toolset = await createAgentToolset({
      cwd: tempCwd(),
      permissionGate: mcpTestPermissionGate(),
      onOperatorGate: async () => ({ kind: "cancel" }),
      mcpServers: [acme, lin],
    });
    const states: MCPServerState[] = [];
    const exit = new AbortController();
    let resumed = false;
    try {
      const started = Date.now();
      await runTuiMcpDial(
        (signal) => toolset.connectMCP(callbacks(states), signal),
        exit.signal,
        40,
      ).then(async () => {
        resumed = true;
      });
      expect(Date.now() - started).toBeLessThan(500);
      expect(resumed).toBe(true);
      expect(states.some((s) => s.name === "lin" && s.state === "failed")).toBe(
        true,
      );
      expect(
        states.some((s) => s.name === "acme" && s.state === "connected"),
      ).toBe(true);
      expect(toolset.hasMCPServer("acme")).toBe(true);
      expect(toolset.hasMCPServer("lin")).toBe(false);
      expect(mock.closedClients).not.toContain("acme");
      expect(
        toolset.dynamicRunner.currentDefinitions().map((d) => d.name),
      ).toContain("mcp__acme__list");
    } finally {
      await toolset.dispose();
    }
  });

  test("unfinished browser auth survives the handshake cap and the live sibling stays mounted", async () => {
    mock.browserAuthNames.add("lin");
    mock.hangNames.add("stuck");
    const toolset = await createAgentToolset({
      cwd: tempCwd(),
      permissionGate: mcpTestPermissionGate(),
      onOperatorGate: async () => ({ kind: "cancel" }),
      mcpServers: [acme, lin, stuck],
    });
    const states: MCPServerState[] = [];
    const exit = new AbortController();
    let resumed = false;
    const dial = runTuiMcpDial(
      (signal) =>
        toolset.connectMCP(callbacks(states, true), signal).then(async () => {
          resumed = true;
        }),
      exit.signal,
      40,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(resumed).toBe(false);
      expect(states.some((s) => s.name === "lin" && s.state === "failed")).toBe(
        false,
      );
      expect(
        states.some((s) => s.name === "lin" && s.state === "needs-auth"),
      ).toBe(true);
      expect(
        states.some((s) => s.name === "stuck" && s.state === "failed"),
      ).toBe(true);
      expect(
        states.some((s) => s.name === "acme" && s.state === "connected"),
      ).toBe(true);
      expect(toolset.hasMCPServer("acme")).toBe(true);
      expect(toolset.hasMCPServer("stuck")).toBe(false);
      expect(mock.closedClients).not.toContain("acme");
      expect(
        toolset.dynamicRunner.currentDefinitions().map((d) => d.name),
      ).toContain("mcp__acme__list");
      expect(mock.authWaitAborts).toBe(0);
    } finally {
      await toolset.dispose();
      await dial;
    }
  });

  test("a trust prompt longer than the dial cap still connects on a live signal", async () => {
    const toolset = await createAgentToolset({
      cwd: tempCwd(),
      permissionGate: mcpTestPermissionGate(),
      onOperatorGate: async () => ({ kind: "cancel" }),
      mcpServers: [acme],
      mcpServersSource: "local",
      projectTrust: {
        trustedPluginPaths: [],
        trustedMcpFingerprints: [],
        trustedGrantFingerprints: [],
      },
      requestMcpTrust: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return true;
      },
    });
    const exit = new AbortController();
    try {
      await runTuiMcpDial(
        (signal) => toolset.connectMCP(callbacks([]), signal),
        exit.signal,
        40,
      );
      expect(mock.connectOptions).toHaveLength(1);
      expect(mock.connectOptions[0]?.signal?.aborted).toBe(false);
      expect(toolset.hasMCPServer("acme")).toBe(true);
    } finally {
      await toolset.dispose();
    }
  });
});
