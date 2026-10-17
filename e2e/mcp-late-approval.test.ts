import { describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";

import type { MCPClient } from "../src/mcp/client.js";
import { mcpClientTools } from "../src/mcp/plugin.js";
import { createPermissionGate } from "../src/permission/gate.js";
import { createReactorAuthorize } from "../src/permission/reactor-authorize.js";
import {
  createApprovalResume,
  resolveParkedCallIdFromStore,
} from "../src/session/approval-resume.js";
import {
  closeIntegrationSession,
  openIntegrationSession,
  runUntilDone,
  runUntilSuspended,
  toolDoneEvents,
  type IntegrationSession,
} from "./integration-harness.js";

// A mutating MCP tool: classifyTool puts it on the ask tier.
const SAVE_ISSUE = "mcp__linear__save_issue";

function deferredApprovalGate() {
  const asks: string[] = [];
  let release: ((outcome: { allow: boolean }) => void) | undefined;
  return {
    asks,
    gate: createPermissionGate({
      // Search is ask-tier outside auto mode; grant it so only the late
      // tool's own authorization is under test.
      approvals: [{ tool: "tool_search", pattern: "*" }],
      interactive: true,
      skipPermissions: false,
      auto: false,
      reactorGated: true,
      requestApproval: (request) => {
        asks.push(request.tool);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    }),
    approve: () => release?.({ allow: true }),
  };
}

function linearClient(calls: Record<string, unknown>[]): MCPClient {
  return {
    serverName: "linear",
    tools: [
      {
        name: "save_issue",
        description: "create or update a linear issue",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
        },
      },
    ],
    async callResult(_toolName, args) {
      calls.push(args);
      return { blocks: [{ type: "text", text: "SAVED-1" }], isError: false };
    },
    async close() {
      return undefined;
    },
  };
}

async function withLateLinear(
  opts: { pinToolSetAtBuild: boolean },
  body: (
    session: IntegrationSession,
    ctx: ReturnType<typeof deferredApprovalGate>,
    calls: Record<string, unknown>[],
  ) => Promise<void>,
): Promise<void> {
  const ctx = deferredApprovalGate();
  const session = await openIntegrationSession({
    permissionGate: ctx.gate,
    authorize: createReactorAuthorize(ctx.gate),
    pinToolSetAtBuild: opts.pinToolSetAtBuild,
  });
  const calls: Record<string, unknown>[] = [];
  try {
    // The server connects after the agent was built, as /mcp add, retry,
    // enable, or a slow startup connect would.
    session.toolset.dynamicRunner.addTools(mcpClientTools(linearClient(calls)));
    await body(session, ctx, calls);
  } finally {
    await closeIntegrationSession(session);
  }
}

// tool.done carries only the result, and a blocked call never starts, so
// name the call ids from the assistant turns that requested them.
function toolDoneFor(
  events: ReactorEmittedEvent[],
  name: string,
): Extract<ReactorEmittedEvent, { type: "tool.done" }> | undefined {
  const callIds = new Set(
    events.flatMap((event) =>
      event.type === "inference.done"
        ? event.data.turn.content.flatMap((block) =>
            block.type === "tool_call" && block.name === name ? [block.id] : [],
          )
        : [],
    ),
  );
  return toolDoneEvents(events).find((event) =>
    callIds.has(event.data.result.callId),
  );
}

const contentOf = (
  event: Extract<ReactorEmittedEvent, { type: "tool.done" }> | undefined,
): string =>
  typeof event?.data.result.content === "string"
    ? event.data.result.content
    : "";

async function waitForAsk(asks: string[]): Promise<void> {
  for (let i = 0; i < 100 && asks.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("integration — late MCP tool approval", () => {
  // Characterization of why a late tool needs a rebuild: the reactor
  // authorizes against the definitions it snapshotted at build.
  test.serial(
    "without a rebuild an ask on a late MCP tool never reaches the operator",
    async () => {
      await withLateLinear(
        { pinToolSetAtBuild: false },
        async (session, ctx, calls) => {
          session.harness.scenario.replyOnce("anthropic", {
            toolCalls: [{ name: SAVE_ISSUE, args: { title: "late" } }],
          });
          session.harness.scenario.replyOnce("anthropic", { text: "gave up" });

          const { events } = await runUntilDone(session, "file the issue");
          const done = toolDoneFor(events, SAVE_ISSUE);
          expect(done?.data.result.isError).toBe(true);
          expect(ctx.asks).toEqual([]);
          expect(calls).toEqual([]);
        },
      );
    },
  );

  test.serial(
    "a late MCP tool is not advertised or callable before the rebuild",
    async () => {
      await withLateLinear(
        { pinToolSetAtBuild: true },
        async (session, ctx, calls) => {
          session.harness.scenario.replyOnce("anthropic", {
            toolCalls: [
              { name: "tool_search", args: { query: "linear save issue" } },
            ],
          });
          session.harness.scenario.replyOnce("anthropic", {
            toolCalls: [{ name: SAVE_ISSUE, args: { title: "late" } }],
          });
          session.harness.scenario.replyOnce("anthropic", {
            text: "next turn",
          });

          const { events } = await runUntilDone(session, "file the issue");
          const search = contentOf(toolDoneFor(events, "tool_search"));
          expect(search).toContain("callable once it ends");
          expect(search).not.toContain("Matching tools");
          const call = toolDoneFor(events, SAVE_ISSUE);
          expect(call?.data.result.isError).toBe(true);
          expect(contentOf(call)).toContain("callable once the turn ends");
          expect(ctx.asks).toEqual([]);
          expect(calls).toEqual([]);
        },
      );
    },
  );

  test.serial(
    "after the rebuild a late mutating MCP tool asks, runs once on approval, and returns its result",
    async () => {
      await withLateLinear(
        { pinToolSetAtBuild: true },
        async (session, ctx, calls) => {
          await session.rebuild();
          session.harness.scenario.replyOnce("anthropic", {
            toolCalls: [
              { name: "tool_search", args: { query: "linear save issue" } },
            ],
          });
          session.harness.scenario.replyOnce("anthropic", {
            toolCalls: [{ name: SAVE_ISSUE, args: { title: "late" } }],
          });
          session.harness.scenario.replyOnce("anthropic", { text: "Saved." });

          const turn = await runUntilSuspended(session, "file the issue");
          const { result } = turn;
          expect(result.type).toBe("suspended");
          if (result.type !== "suspended") return;
          expect(contentOf(toolDoneFor(turn.events, "tool_search"))).toContain(
            SAVE_ISSUE,
          );
          expect(result.approvalSnapshot?.name).toBe(SAVE_ISSUE);
          expect(calls).toEqual([]);

          const resume = createApprovalResume({
            getAgent: () => session.agent,
            resolveParkedCallId: (correlationId) =>
              resolveParkedCallIdFromStore(session.storage, correlationId),
            gate: ctx.gate,
          });
          const handling = resume.handle(result);
          await waitForAsk(ctx.asks);
          expect(ctx.asks).toEqual([SAVE_ISSUE]);
          ctx.approve();
          expect(await handling).toBe(true);

          expect(await turn.reply()).toBe("Saved.");
          expect(calls).toEqual([{ title: "late" }]);
          const done = toolDoneFor(turn.events, SAVE_ISSUE);
          expect(done?.data.result.isError).not.toBe(true);
          expect(contentOf(done)).toContain("SAVED-1");
        },
      );
    },
  );
});
