import { describe, expect, test } from "bun:test";
import { createAgent } from "@intx/agent";
import type { ReactorEmittedEvent } from "@intx/inference";

import { createAgentWithLiveToolDispatch } from "../../src/agent/live-tool-dispatch.js";
import type { MCPClient } from "../../src/mcp/client.js";
import { mcpClientTools } from "../../src/mcp/plugin.js";
import { createPermissionGate } from "../../src/permission/gate.js";
import {
  closeIntegrationSession,
  openIntegrationSession,
  runUntilDone,
} from "./harness.js";

const LATE_MCP = "mcp__linear__list_issues";
const LATE_MCP_SCHEMA = {
  type: "object" as const,
  properties: {
    limit: { type: "integer" },
    team: { type: "string" },
  },
};

interface AnthropicRequestBody {
  tools?: {
    name: string;
    input_schema: Record<string, unknown>;
  }[];
}

function permissionGate() {
  return createPermissionGate({
    approvals: [],
    interactive: false,
    skipPermissions: true,
    reactorGated: false,
  });
}

function lateMcpTools(
  onCall?: (toolName: string, args: Record<string, unknown>) => void,
) {
  const client: MCPClient = {
    serverName: "linear",
    tools: [
      {
        name: "list_issues",
        description: "list issues",
        inputSchema: LATE_MCP_SCHEMA,
      },
    ],
    async call(toolName, args) {
      onCall?.(toolName, args);
      return "ISSUE-1";
    },
    async close() {
      return undefined;
    },
  };
  return mcpClientTools(client);
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
        session.toolset.dynamicRunner.addTools(lateMcpTools());
        session.harness.scenario.replyOnce("anthropic", {
          toolCalls: [{ name: LATE_MCP, args: {} }],
        });
        session.harness.scenario.replyOnce("anthropic", { text: "listed" });

        const { events } = await runUntilDone(session, "list linear issues");
        const loud = events.find(
          (
            event,
          ): event is Extract<ReactorEmittedEvent, { type: "tool.done" }> =>
            event.type === "tool.done" &&
            typeof event.data.result.content === "string" &&
            event.data.result.content.includes(`unknown tool: ${LATE_MCP}`),
        );
        expect(loud).toBeDefined();
        expect(loud?.data.result.isError).toBe(true);
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
        session.toolset.dynamicRunner.addTools(lateMcpTools());
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
    "unknown MCP tool dispatch fails loudly instead of altering results",
    async () => {
      const session = await openIntegrationSession({
        permissionGate: permissionGate(),
        createAgentFn: createAgentWithLiveToolDispatch,
      });

      try {
        session.toolset.dynamicRunner.addTools(lateMcpTools());
        const missing = "mcp__linear__no_such_tool";
        session.harness.scenario.replyOnce("anthropic", {
          toolCalls: [{ name: missing, args: {} }],
        });
        session.harness.scenario.replyOnce("anthropic", { text: "refused" });

        const { events } = await runUntilDone(session, "delete everything");
        const loud = events.find(
          (
            event,
          ): event is Extract<ReactorEmittedEvent, { type: "tool.done" }> =>
            event.type === "tool.done" &&
            typeof event.data.result.content === "string" &&
            event.data.result.content.includes(`unknown tool: ${missing}`),
        );
        expect(loud).toBeDefined();
        expect(loud?.data.result.isError).toBe(true);
      } finally {
        await closeIntegrationSession(session);
      }
    },
  );

  test.serial(
    "out-of-scope MCP arguments fail loudly with an actionable error",
    async () => {
      const session = await openIntegrationSession({
        permissionGate: permissionGate(),
        createAgentFn: createAgentWithLiveToolDispatch,
      });

      try {
        const client: MCPClient = {
          serverName: "linear",
          tools: [
            {
              name: "list_issues",
              description: "list issues",
              inputSchema: LATE_MCP_SCHEMA,
            },
          ],
          async call(toolName, args) {
            if (toolName === "list_issues" && args.team === "rogue") {
              throw new Error(
                'scope denied: team "rogue" is not in scope for this connection',
              );
            }
            return "ISSUE-1";
          },
          async close() {
            return undefined;
          },
        };
        session.toolset.dynamicRunner.addTools(mcpClientTools(client));
        session.harness.scenario.replyOnce("anthropic", {
          toolCalls: [{ name: LATE_MCP, args: { limit: 1, team: "rogue" } }],
        });
        session.harness.scenario.replyOnce("anthropic", { text: "refused" });

        const { events } = await runUntilDone(
          session,
          "list rogue team issues",
        );
        const loud = events.find(
          (
            event,
          ): event is Extract<ReactorEmittedEvent, { type: "tool.done" }> =>
            event.type === "tool.done" &&
            typeof event.data.result.content === "string" &&
            event.data.result.content.includes("scope denied"),
        );
        expect(loud).toBeDefined();
        expect(loud?.data.result.isError).toBe(true);
        expect(loud?.data.result.content).toContain("not in scope");
      } finally {
        await closeIntegrationSession(session);
      }
    },
  );

  test.serial(
    "tool_search promotion preserves optional MCP arguments",
    async () => {
      const session = await openIntegrationSession({
        permissionGate: permissionGate(),
        createAgentFn: createAgentWithLiveToolDispatch,
      });
      let receivedArgs: Record<string, unknown> | undefined;

      try {
        const tools = lateMcpTools((toolName, args) => {
          if (toolName === "list_issues") {
            receivedArgs = args;
          }
        });
        expect(tools).toHaveLength(1);
        expect(tools[0]?.kind).toBe("full");
        const expectedSchema = structuredClone(LATE_MCP_SCHEMA);
        session.toolset.dynamicRunner.addTools(tools);
        session.toolset.setToolPromoter(() => {
          session.updateToolDefinitions(
            session.toolset.dynamicRunner.currentDefinitions(),
          );
        });
        session.harness.scenario.replyOnce("anthropic", {
          toolCalls: [
            { name: "tool_search", args: { query: "linear list issues" } },
          ],
        });
        session.harness.scenario.replyOnce("anthropic", {
          toolCalls: [{ name: LATE_MCP, args: { limit: 1, team: "eng" } }],
        });
        session.harness.scenario.replyOnce("anthropic", { text: "listed" });

        const { events } = await runUntilDone(session, "list one linear issue");
        const bodies = await Promise.all(
          session.harness.scenario
            .matchedRequests()
            .map(
              async (request) =>
                JSON.parse(
                  await (request.clone() as unknown as Request).text(),
                ) as AnthropicRequestBody,
            ),
        );
        const publishedTool = bodies
          .flatMap((body) => body.tools ?? [])
          .find((tool) => tool.name === LATE_MCP);

        expect(publishedTool?.input_schema.properties).toEqual(
          expectedSchema.properties,
        );
        expect(
          Object.hasOwn(publishedTool?.input_schema ?? {}, "required"),
        ).toBe(false);
        expect(receivedArgs).toEqual({ limit: 1, team: "eng" });
        expect(toolDoneContents(events)).toContain("ISSUE-1");
      } finally {
        await closeIntegrationSession(session);
      }
    },
  );

  test.serial(
    "tool_search promotion does not inject omitted optional MCP arguments",
    async () => {
      const session = await openIntegrationSession({
        permissionGate: permissionGate(),
        createAgentFn: createAgentWithLiveToolDispatch,
      });
      let receivedArgs: Record<string, unknown> | undefined;

      try {
        const tools = lateMcpTools((toolName, args) => {
          if (toolName === "list_issues") {
            receivedArgs = args;
          }
        });
        expect(tools).toHaveLength(1);
        expect(tools[0]?.kind).toBe("full");
        const expectedSchema = structuredClone(LATE_MCP_SCHEMA);
        session.toolset.dynamicRunner.addTools(tools);
        session.toolset.setToolPromoter(() => {
          session.updateToolDefinitions(
            session.toolset.dynamicRunner.currentDefinitions(),
          );
        });
        session.harness.scenario.replyOnce("anthropic", {
          toolCalls: [
            { name: "tool_search", args: { query: "linear list issues" } },
          ],
        });
        session.harness.scenario.replyOnce("anthropic", {
          toolCalls: [{ name: LATE_MCP, args: { limit: 1 } }],
        });
        session.harness.scenario.replyOnce("anthropic", { text: "listed" });

        const { events } = await runUntilDone(session, "list one linear issue");
        const bodies = await Promise.all(
          session.harness.scenario
            .matchedRequests()
            .map(
              async (request) =>
                JSON.parse(
                  await (request.clone() as unknown as Request).text(),
                ) as AnthropicRequestBody,
            ),
        );
        const publishedTool = bodies
          .flatMap((body) => body.tools ?? [])
          .find((tool) => tool.name === LATE_MCP);

        expect(publishedTool?.input_schema.properties).toEqual(
          expectedSchema.properties,
        );
        expect(
          Object.hasOwn(publishedTool?.input_schema ?? {}, "required"),
        ).toBe(false);
        expect(receivedArgs).toEqual({ limit: 1 });
        expect(toolDoneContents(events)).toContain("ISSUE-1");
      } finally {
        await closeIntegrationSession(session);
      }
    },
  );

  test.serial(
    "tool_search promotion preserves required and optional MCP arguments",
    async () => {
      const session = await openIntegrationSession({
        permissionGate: permissionGate(),
        createAgentFn: createAgentWithLiveToolDispatch,
      });
      let receivedArgs: Record<string, unknown> | undefined;
      const schema = {
        type: "object" as const,
        properties: {
          limit: { type: "integer" },
          team: { type: "string" },
          customView: { type: "string" },
        },
        required: ["limit"],
      };

      try {
        const client: MCPClient = {
          serverName: "linear",
          tools: [
            {
              name: "list_issues",
              description: "list issues",
              inputSchema: schema,
            },
          ],
          async call(toolName, args) {
            if (toolName === "list_issues") {
              receivedArgs = args;
            }
            return "ISSUE-1";
          },
          async close() {
            return undefined;
          },
        };
        const expectedSchema = structuredClone(schema);
        session.toolset.dynamicRunner.addTools(mcpClientTools(client));
        session.toolset.setToolPromoter(() => {
          session.updateToolDefinitions(
            session.toolset.dynamicRunner.currentDefinitions(),
          );
        });
        session.harness.scenario.replyOnce("anthropic", {
          toolCalls: [
            { name: "tool_search", args: { query: "linear list issues" } },
          ],
        });
        session.harness.scenario.replyOnce("anthropic", {
          toolCalls: [
            {
              name: LATE_MCP,
              args: { limit: 1, team: "eng", customView: "mine" },
            },
          ],
        });
        session.harness.scenario.replyOnce("anthropic", { text: "listed" });

        const { events } = await runUntilDone(session, "list one linear issue");
        const bodies = await Promise.all(
          session.harness.scenario
            .matchedRequests()
            .map(
              async (request) =>
                JSON.parse(
                  await (request.clone() as unknown as Request).text(),
                ) as AnthropicRequestBody,
            ),
        );
        const publishedTool = bodies
          .flatMap((body) => body.tools ?? [])
          .find((tool) => tool.name === LATE_MCP);

        expect(publishedTool?.input_schema).toEqual(expectedSchema);
        expect(receivedArgs).toEqual({
          limit: 1,
          team: "eng",
          customView: "mine",
        });
        expect(toolDoneContents(events)).toContain("ISSUE-1");
      } finally {
        await closeIntegrationSession(session);
      }
    },
  );
});
