/**
 * CL-9704: Linear MCP discovery-to-invocation on the primary session.
 *
 * Regression lock for "discoverable but not callable": tool_search finds
 * `mcp__linear__*`, and promote-on-execute must then commit a callable
 * schema for exactly the called name and dispatch it — list_teams first,
 * then save_issue. Search alone never promotes (the wire stays
 * built-ins-only until a call), and promoting one name never implies its
 * siblings: the primary session mounts MCP tools on demand, mirroring the
 * worker requires_tools gate.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installMcpConnectMock,
  linearHttpMcpServer,
  mcpTestPermissionGate,
} from "../../testkit/mcp-connect-mock.js";

const linearTools = [
  {
    name: "list_teams",
    description: "List Linear teams",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "save_issue",
    description: "Save a Linear issue",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        teamId: { type: "string" },
      },
      required: ["title"],
    },
  },
];

const mock = await installMcpConnectMock(
  import.meta.resolve("../mcp/client.js"),
  { initialTools: linearTools, toolCallResult: "linear-ok" },
);

const { createAgentToolset } = await import("./tools.js");
const { createToolIndex, createToolSearchTool } =
  await import("./tool-search.js");
const { createAdvertisedToolset } =
  await import("../session/assemble-runtime.js");

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  mock.reset();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CL-9704 linear MCP discovery-to-invocation", () => {
  test("tool_search finds list_teams, promote-on-execute makes list_teams then save_issue callable", async () => {
    const toolset = await createAgentToolset({
      cwd: tempDir("corbits-cl9704-"),
      permissionGate: mcpTestPermissionGate(),
      onOperatorGate: async () => ({ kind: "cancel" }),
      mcpServers: [linearHttpMcpServer],
    });
    try {
      await toolset.connectMCP({
        interactiveAuth: false,
        onStatus: () => undefined,
        onToolsChanged: () => undefined,
      });

      const registered = toolset.dynamicRunner
        .currentDefinitions()
        .map((d) => d.name);
      expect(registered).toContain("mcp__linear__list_teams");
      expect(registered).toContain("mcp__linear__save_issue");

      // Primary-session promote-on-execute wiring (mirrors
      // tui/runner/session.ts + tui/runner/exit.ts): the call gate keys off
      // the advertised set, and the promoter declares exactly the called
      // name, committing its schema onto the next infer's wire.
      const advertised = createAdvertisedToolset({
        sessionMode: "orchestrator",
        toolAvailability: { languageServerAvailable: false },
        getProvider: () => ({ providerName: "test", model: "test" }),
      });
      toolset.dynamicRunner.setCallGate(
        (name) => advertised.isAdvertised(name),
        { isActivated: (name) => advertised.activated.has(name) },
      );
      let wire: string[] = [];
      toolset.setToolPromoter((names) => {
        advertised.activated.activate(names);
        if (advertised.flushPromotions()) {
          wire = advertised
            .computeAdvertised(toolset.dynamicRunner.currentDefinitions())
            .map((d) => d.name);
        }
      });
      const wireSchemas = (): Map<string, unknown> =>
        new Map(
          advertised
            .computeAdvertised(toolset.dynamicRunner.currentDefinitions())
            .map((d) => [d.name, d.inputSchema]),
        );

      const index = createToolIndex(() =>
        toolset.dynamicRunner.currentDefinitions(),
      );
      const search = createToolSearchTool({
        search: (query, limit) => index.search(query, limit),
        lookup: (name) =>
          toolset.dynamicRunner
            .currentDefinitions()
            .find((d) => d.name === name),
      });
      if (search.kind !== "string") throw new Error("expected string tool");

      // Discovery: the card names list_teams with its description.
      const card = await search.handler(
        { query: "linear teams" },
        new AbortController().signal,
      );
      expect(card).toContain("mcp__linear__list_teams");
      expect(card).toContain("List Linear teams");

      // Search alone promotes nothing: no Linear schema on the wire.
      expect(wire).not.toContain("mcp__linear__list_teams");
      expect(wire).not.toContain("mcp__linear__save_issue");

      const run = (name: string, args: Record<string, unknown> = {}) =>
        toolset.dynamicRunner.run(
          { id: `call-${name}`, name, arguments: args },
          new AbortController().signal,
        );

      // Invocation 1: list_teams dispatches and promotes only itself.
      const listed = await run("mcp__linear__list_teams");
      expect(listed.isError).toBeUndefined();
      expect(listed.content).toContain("linear-ok");
      expect(wire).toContain("mcp__linear__list_teams");
      expect(wire).not.toContain("mcp__linear__save_issue");
      expect(wireSchemas().get("mcp__linear__list_teams")).toEqual(
        linearTools[0]?.inputSchema,
      );

      // Invocation 2: save_issue dispatches with its args after discovery.
      const saved = await run("mcp__linear__save_issue", {
        title: "hello",
        teamId: "t1",
      });
      expect(saved.isError).toBeUndefined();
      expect(saved.content).toContain("linear-ok");
      expect(wire).toEqual(
        expect.arrayContaining([
          "mcp__linear__list_teams",
          "mcp__linear__save_issue",
        ]),
      );
      expect(mock.calls.map((c) => c.toolName)).toEqual([
        "list_teams",
        "save_issue",
      ]);
      expect(mock.calls[1]?.args).toEqual({ title: "hello", teamId: "t1" });
    } finally {
      await toolset.dispose();
    }
  });
});
