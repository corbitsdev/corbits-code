import { describe, expect, test } from "bun:test";
import { createAgent } from "@intx/agent";
import type { ReactorEmittedEvent } from "@intx/inference";

import { createAgentWithLiveToolDispatch } from "../../src/agent/live-tool-dispatch.js";
import { createPermissionGate } from "../../src/permission/gate.js";
import { closeIntegrationSession, openIntegrationSession, runUntilDone } from "./harness.js";

const LATE_MCP = "mcp__linear__list_issues";

function permissionGate() {
  return createPermissionGate({
    approvals: [],
    interactive: false,
    skipPermissions: true,
  });
}

function lateMcpTool() {
  return {
    kind: "string" as const,
    definition: {
      name: LATE_MCP,
      description: "list issues",
      inputSchema: { type: "object" as const, properties: {}, required: [] as string[] },
    },
    handler: async () => "ISSUE-1",
  };
}

function toolDoneContents(events: ReactorEmittedEvent[]): string[] {
  return events
    .filter((event): event is Extract<ReactorEmittedEvent, { type: "tool.done" }> => event.type === "tool.done")
    .map((event) => (typeof event.data.result.content === "string" ? event.data.result.content : ""));
}

describe("integration — late MCP dispatch", () => {
  // Characterization: drop createAgentWithLiveToolDispatch when this starts
  // failing because published @intx/agent learned to consult live definitions.
  test.serial("published createAgent freezes dispatch names at construction", async () => {
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
      expect(toolDoneContents(events).some((content) => content.includes(`unknown tool: ${LATE_MCP}`))).toBe(
        true,
      );
    } finally {
      await closeIntegrationSession(session);
    }
  });

  test.serial("MCP tools added after createAgent dispatch instead of unknown tool", async () => {
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
      expect(contents.some((content) => content.includes("unknown tool"))).toBe(false);
    } finally {
      await closeIntegrationSession(session);
    }
  });
});
