import { describe, expect, test } from "bun:test";
import { createAgent } from "@intx/agent";
import type { ReactorEmittedEvent } from "@intx/inference";

import { createAgentWithLiveToolDispatch } from "../../src/agent/live-tool-dispatch.js";
import type { MCPClient } from "../../src/mcp/client.js";
import { mcpClientToAgentTools } from "../../src/mcp/plugin.js";
import { createPermissionGate } from "../../src/permission/gate.js";
import {
  closeIntegrationSession,
  openIntegrationSession,
  runUntilDone,
} from "./harness.js";

const LATE_MCP = "mcp__linear__list_issues";
const OPTIONAL_SCHEMA = {
  type: "object" as const,
  properties: {
    limit: { type: "number" },
    query: { type: "string" },
    team: { type: "string" },
  },
};

function permissionGate() {
  return createPermissionGate({
    approvals: [],
    interactive: false,
    skipPermissions: true,
    reactorGated: false,
  });
}

function lateMcpTool() {
  return {
    kind: "string" as const,
    definition: {
      name: LATE_MCP,
      description: "list issues",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [] as string[],
      },
    },
    handler: async () => "ISSUE-1",
  };
}

function toolDoneContents(events: ReactorEmittedEvent[]): string[] {
  return events
    .filter(
      (event): event is Extract<ReactorEmittedEvent, { type: "tool.done" }> =>
        event.type === "tool.done",
    )
    .map((event) =>
      typeof event.data.result.content === "string"
        ? event.data.result.content
        : "",
    );
}

describe("integration — late MCP dispatch", () => {
  // Characterization: drop createAgentWithLiveToolDispatch when this starts
  // failing because published @intx/agent learned to consult live definitions.
  test.serial(
    "published createAgent freezes dispatch names at construction",
    async () => {
      const session = await openIntegrationSession({
        permissionGate: permissionGate(),
        createAgentFn: createAgent,
      });

      try {
        session.toolset.dynamicRunner.addTools([lateMcpTool()]);
        session.harness.scenario.replyOnce("anthropic", {
          toolCalls: [{ name: LATE_MCP, args: {} }],
        });
        session.harness.scenario.replyOnce("anthropic", { text: "listed" });

        const { events } = await runUntilDone(session, "list linear issues");
        expect(
          toolDoneContents(events).some((content) =>
            content.includes(`unknown tool: ${LATE_MCP}`),
          ),
        ).toBe(true);
      } finally {
        await closeIntegrationSession(session);
      }
    },
  );

  test.serial(
    "MCP tools added after createAgent dispatch instead of unknown tool",
    async () => {
      const session = await openIntegrationSession({
        permissionGate: permissionGate(),
        createAgentFn: createAgentWithLiveToolDispatch,
      });

      try {
        session.toolset.dynamicRunner.addTools([lateMcpTool()]);
        session.harness.scenario.replyOnce("anthropic", {
          toolCalls: [{ name: LATE_MCP, args: {} }],
        });
        session.harness.scenario.replyOnce("anthropic", { text: "listed" });

        const { events } = await runUntilDone(session, "list linear issues");
        const contents = toolDoneContents(events);
        expect(contents).toContain("ISSUE-1");
        expect(
          contents.some((content) => content.includes("unknown tool")),
        ).toBe(false);
      } finally {
        await closeIntegrationSession(session);
      }
    },
  );

  test.serial(
    "optional MCP schemas stay optional through publication and sparse dispatch",
    async () => {
      const gate = permissionGate();
      const session = await openIntegrationSession({ permissionGate: gate });
      let receivedArgs: Record<string, unknown> | undefined;
      const client: MCPClient = {
        serverName: "linear",
        tools: [
          {
            name: "list_issues",
            description: "list issues",
            inputSchema: OPTIONAL_SCHEMA,
          },
        ],
        async call(_toolName, args) {
          receivedArgs = args;
          return "ISSUE-1";
        },
        async close() {
          return undefined;
        },
      };

      try {
        gate.registerMcpClient(client);
        session.toolset.dynamicRunner.addTools(
          mcpClientToAgentTools(client, gate),
        );
        session.toolset.setToolPromoter(() => {
          session.updateToolDefinitions(
            session.toolset.dynamicRunner.currentDefinitions(),
          );
        });
        const mounted = session.toolset.dynamicRunner
          .currentDefinitions()
          .find((definition) => definition.name === LATE_MCP);
        expect(mounted?.inputSchema.properties).toEqual(
          OPTIONAL_SCHEMA.properties,
        );
        expect(Object.hasOwn(mounted?.inputSchema ?? {}, "required")).toBe(
          false,
        );

        session.harness.scenario.replyOnce("anthropic", {
          toolCalls: [{ name: "tool_search", args: { query: "list issues" } }],
        });
        session.harness.scenario.replyOnce("anthropic", {
          toolCalls: [{ name: LATE_MCP, args: { limit: 1 } }],
        });
        session.harness.scenario.replyOnce("anthropic", { text: "listed" });

        const { events } = await runUntilDone(session, "list one issue");
        expect(toolDoneContents(events)).toContain("ISSUE-1");
        expect(receivedArgs).toEqual({ limit: 1 });

        const requests = session.harness.scenario.matchedRequests();
        const bodies = await Promise.all(
          requests.map((request) =>
            (request.clone() as unknown as Request).json(),
          ),
        );
        const published = bodies
          .flatMap((body) => {
            if (typeof body !== "object" || body === null) return [];
            const tools = (body as { tools?: unknown }).tools;
            return Array.isArray(tools) ? tools : [];
          })
          .find(
            (tool) =>
              typeof tool === "object" &&
              tool !== null &&
              (tool as { name?: unknown }).name === LATE_MCP,
          );
        expect(published).toBeDefined();
        const publishedSchema = (
          published as { input_schema?: Record<string, unknown> }
        ).input_schema;
        expect(publishedSchema?.properties).toEqual(OPTIONAL_SCHEMA.properties);
        expect(Object.hasOwn(publishedSchema ?? {}, "required")).toBe(false);
      } finally {
        await closeIntegrationSession(session);
      }
    },
  );
});
