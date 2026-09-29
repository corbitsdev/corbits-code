import { describe, expect, test } from "bun:test";
import { createAgent } from "@intx/agent";
import type { ReactorEmittedEvent } from "@intx/inference";

import { createAgentWithLiveToolDispatch } from "../src/agent/live-tool-dispatch.js";
import type { MCPClient } from "../src/mcp/client.js";
import { mcpClientTools } from "../src/mcp/plugin.js";
import { createPermissionGate } from "../src/permission/gate.js";
import {
  closeIntegrationSession,
  openIntegrationSession,
  runUntilDone,
  toolDoneEvents,
  type IntegrationSession,
} from "./integration-harness.js";

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

function linearClient(opts: {
  inputSchema?: MCPClient["tools"][number]["inputSchema"];
  call?: MCPClient["call"];
}): MCPClient {
  return {
    serverName: "linear",
    tools: [
      {
        name: "list_issues",
        description: "list issues",
        inputSchema: opts.inputSchema ?? LATE_MCP_SCHEMA,
      },
    ],
    call: opts.call ?? (async () => "ISSUE-1"),
    async close() {
      return undefined;
    },
  };
}

function lateMcpTools(
  onCall?: (toolName: string, args: Record<string, unknown>) => void,
) {
  return mcpClientTools(
    linearClient({
      call: async (toolName, args) => {
        onCall?.(toolName, args);
        return "ISSUE-1";
      },
    }),
  );
}

async function withSession(
  body: (session: IntegrationSession) => Promise<void>,
  createAgentFn: typeof createAgent = createAgentWithLiveToolDispatch,
): Promise<void> {
  const session = await openIntegrationSession({
    permissionGate: permissionGate(),
    createAgentFn,
  });
  try {
    await body(session);
  } finally {
    await closeIntegrationSession(session);
  }
}

// The loud-failure shape under test: a tool.done whose content names the
// missing tool, flagged isError.
function loudToolError(
  events: ReactorEmittedEvent[],
  marker: string,
): Extract<ReactorEmittedEvent, { type: "tool.done" }> | undefined {
  return toolDoneEvents(events).find(
    (event) =>
      typeof event.data.result.content === "string" &&
      event.data.result.content.includes(marker),
  );
}

function toolDoneContents(events: ReactorEmittedEvent[]): string[] {
  return toolDoneEvents(events).map((event) =>
    typeof event.data.result.content === "string"
      ? event.data.result.content
      : "",
  );
}

// Registers dynamic tools as promotable so the next request advertises them.
function promoteDynamicTools(session: IntegrationSession): void {
  session.toolset.setToolPromoter(() => {
    session.updateToolDefinitions(
      session.toolset.dynamicRunner.currentDefinitions(),
    );
  });
}

function replyScript(
  session: IntegrationSession,
  calls: { name: string; args: Record<string, unknown> }[],
  finalText: string,
): void {
  for (const toolCall of calls) {
    session.harness.scenario.replyOnce("anthropic", { toolCalls: [toolCall] });
  }
  session.harness.scenario.replyOnce("anthropic", { text: finalText });
}

async function requestBodies(
  session: IntegrationSession,
): Promise<AnthropicRequestBody[]> {
  return Promise.all(
    session.harness.scenario
      .matchedRequests()
      .map(
        async (request) =>
          JSON.parse(
            await (request.clone() as unknown as Request).text(),
          ) as AnthropicRequestBody,
      ),
  );
}

function publishedTool(bodies: AnthropicRequestBody[]) {
  return bodies
    .flatMap((body) => body.tools ?? [])
    .find((tool) => tool.name === LATE_MCP);
}

// The tool_search → MCP call script shared by the promotion tests.
function promotionScript(
  session: IntegrationSession,
  args: Record<string, unknown>,
): void {
  replyScript(
    session,
    [
      { name: "tool_search", args: { query: "linear list issues" } },
      { name: LATE_MCP, args },
    ],
    "listed",
  );
}

describe("integration — late MCP dispatch", () => {
  // Characterization: drop createAgentWithLiveToolDispatch when this starts
  // failing because published @intx/agent learned to consult live definitions.
  test.serial(
    "published createAgent freezes dispatch names at construction",
    async () => {
      await withSession(async (session) => {
        session.toolset.dynamicRunner.addTools(lateMcpTools());
        replyScript(session, [{ name: LATE_MCP, args: {} }], "listed");

        const { events } = await runUntilDone(session, "list linear issues");
        const loud = loudToolError(events, `unknown tool: ${LATE_MCP}`);
        expect(loud).toBeDefined();
        expect(loud?.data.result.isError).toBe(true);
      }, createAgent);
    },
  );

  test.serial(
    "MCP tools added after createAgent dispatch instead of unknown tool",
    async () => {
      await withSession(async (session) => {
        session.toolset.dynamicRunner.addTools(lateMcpTools());
        replyScript(session, [{ name: LATE_MCP, args: {} }], "listed");

        const { events } = await runUntilDone(session, "list linear issues");
        const contents = toolDoneContents(events);
        expect(contents).toContain("ISSUE-1");
        expect(
          contents.some((content) => content.includes("unknown tool")),
        ).toBe(false);
      });
    },
  );

  test.serial(
    "unknown MCP tool dispatch fails loudly instead of altering results",
    async () => {
      await withSession(async (session) => {
        session.toolset.dynamicRunner.addTools(lateMcpTools());
        const missing = "mcp__linear__no_such_tool";
        replyScript(session, [{ name: missing, args: {} }], "refused");

        const { events } = await runUntilDone(session, "delete everything");
        const loud = loudToolError(events, `unknown tool: ${missing}`);
        expect(loud).toBeDefined();
        expect(loud?.data.result.isError).toBe(true);
      });
    },
  );

  test.serial(
    "out-of-scope MCP arguments fail loudly with an actionable error",
    async () => {
      await withSession(async (session) => {
        session.toolset.dynamicRunner.addTools(
          mcpClientTools(
            linearClient({
              call: async (toolName, args) => {
                if (toolName === "list_issues" && args.team === "rogue") {
                  throw new Error(
                    'scope denied: team "rogue" is not in scope for this connection',
                  );
                }
                return "ISSUE-1";
              },
            }),
          ),
        );
        replyScript(
          session,
          [{ name: LATE_MCP, args: { limit: 1, team: "rogue" } }],
          "refused",
        );

        const { events } = await runUntilDone(
          session,
          "list rogue team issues",
        );
        const loud = loudToolError(events, "scope denied");
        expect(loud).toBeDefined();
        expect(loud?.data.result.isError).toBe(true);
        expect(loud?.data.result.content).toContain("not in scope");
      });
    },
  );

  // One matrix over the promotion wire contract: schema source (default
  // optional-arg schema vs a required-arg schema), the args the model calls
  // with, and the published shape those imply.
  const promotionCases: {
    name: string;
    schema: MCPClient["tools"][number]["inputSchema"] | undefined;
    call: Record<string, unknown>;
  }[] = [
    {
      name: "preserves optional MCP arguments",
      schema: undefined,
      call: { limit: 1, team: "eng" },
    },
    {
      name: "does not inject omitted optional MCP arguments",
      schema: undefined,
      call: { limit: 1 },
    },
    {
      name: "preserves required and optional MCP arguments",
      schema: {
        type: "object",
        properties: {
          limit: { type: "integer" },
          team: { type: "string" },
          customView: { type: "string" },
        },
        required: ["limit"],
      },
      call: { limit: 1, team: "eng", customView: "mine" },
    },
  ];

  test.serial.each(promotionCases)(
    "tool_search promotion $name",
    async ({ schema, call }) => {
      let receivedArgs: Record<string, unknown> | undefined;
      await withSession(async (session) => {
        if (schema === undefined) {
          const tools = lateMcpTools((toolName, args) => {
            if (toolName === "list_issues") {
              receivedArgs = args;
            }
          });
          expect(tools).toHaveLength(1);
          expect(tools[0]?.kind).toBe("full");
          session.toolset.dynamicRunner.addTools(tools);
        } else {
          session.toolset.dynamicRunner.addTools(
            mcpClientTools(
              linearClient({
                inputSchema: schema,
                call: async (toolName, args) => {
                  if (toolName === "list_issues") {
                    receivedArgs = args;
                  }
                  return "ISSUE-1";
                },
              }),
            ),
          );
        }
        const expectedSchema = structuredClone(schema ?? LATE_MCP_SCHEMA);
        promoteDynamicTools(session);
        promotionScript(session, call);

        const { events } = await runUntilDone(
          session,
          "list one linear issue",
        );
        const published = publishedTool(await requestBodies(session));

        if (schema === undefined) {
          expect(published?.input_schema.properties).toEqual(
            expectedSchema.properties,
          );
          expect(Object.hasOwn(published?.input_schema ?? {}, "required")).toBe(
            false,
          );
        } else {
          expect(published?.input_schema).toEqual(expectedSchema);
        }
        expect(receivedArgs).toEqual(call);
        expect(toolDoneContents(events)).toContain("ISSUE-1");
      });
    },
  );
});
