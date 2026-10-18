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

function callbacks(states: MCPServerState[]) {
  return {
    interactiveAuth: true,
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
});
