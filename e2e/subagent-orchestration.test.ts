import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type } from "arktype";

import { createPermissionGate } from "../src/permission/gate.js";

import { createSubAgentSessionStore } from "../src/subagent/index.js";
import { withMockedModuleDuring } from "../testkit/mock-module.js";
import {
  fromHost,
  waitAgentsGrantRequestId,
  waitAgentsResults,
  WORKER_HOST,
  WORKER_PROVIDER,
} from "./fleet.js";
import {
  closeE2ESession,
  e2ePermissionGate,
  openE2ESession,
  createRuntimeReplies,
  runUntilDone,
} from "./harness.js";
import { DIRECTOR_RESOLVABLE_ESCALATION } from "../testkit/escalation.js";

const RequestURL = type({ url: "string" });
// approve_worker_call's result is raw JSON in its tool.done event but an
// escaped JSON string inside the parent's next request body; one pattern
// tolerates both so the two checks cannot drift apart.
const AUTHORIZED_STATUS = /\\?"status\\?":\s*\\?"authorized\\?"/;
type AuthorizationCheckpoint =
  | "denied-write"
  | "asked-for-approval"
  | "approval-issued"
  | "authorized-retry";

test("wait_agents grant correlation accepts pretty serialized tool output", () => {
  const result = JSON.stringify(
    {
      results: [
        {
          agent_id: "lane-1",
          grant_request_id: "grant-1",
          status: "awaiting_director",
        },
      ],
      timed_out: false,
    },
    null,
    2,
  );
  const request = JSON.stringify({ messages: [{ content: result }] });
  expect(waitAgentsGrantRequestId(request)).toBe("grant-1");
});

async function openFleetSession(
  sessions: ReturnType<typeof createSubAgentSessionStore>,
  permissionGate = e2ePermissionGate(),
) {
  return openE2ESession({
    permissionGate,
    subAgent: {
      provider: WORKER_PROVIDER,
      sessions,
      outerRetryDelayMs: 0,
      // Abort the inner backoff (injected scheduler is inert); the outer
      // whole-send retry owns retry behavior instead.
      retryPolicy: () => ({ kind: "abort" }),
    },
    mountWaitAgents: true,
    toolAvailability: {
      languageServerAvailable: false,
      waitAgentsMounted: true,
    },
  });
}

describe("e2e — fleet orchestration", () => {
  test.serial(
    "a parked ask_director question surfaces through wait_agents and send_input unblocks the worker",
    async () => {
      const fleetSessions = createSubAgentSessionStore();
      const session = await openFleetSession(fleetSessions);
      try {
        const parent = fromHost("api.anthropic.com");
        const worker = fromHost(WORKER_HOST);
        session.harness.scenario.replyOnce("anthropic", {
          predicate: parent,
          text: "Dispatching a worker.",
          toolCalls: [
            {
              // The worker's session id is the spawn call id — pin it for send_input.
              callId: "lane-1",
              name: "spawn_agent",
              args: {
                description: "need a path",
                prompt: "Ask the director which file to edit, then report.",
                intent: "explore",
              },
            },
          ],
        });
        session.harness.scenario.replyOnce("openai", {
          predicate: worker,
          toolCalls: [
            {
              name: "ask_director",
              args: {
                question: "which file should I edit?",
                escalation: DIRECTOR_RESOLVABLE_ESCALATION,
              },
            },
          ],
        });
        session.harness.scenario.replyOnce("anthropic", {
          predicate: parent,
          text: "Checking the lane.",
          toolCalls: [{ name: "wait_agents", args: { timeout_ms: 30_000 } }],
        });
        session.harness.scenario.replyOnce("anthropic", {
          predicate: parent,
          text: "Answering the question.",
          toolCalls: [
            {
              name: "send_input",
              args: { target: "lane-1", message: "edit src/foo.ts" },
            },
          ],
        });
        session.harness.scenario.replyOnce("openai", {
          predicate: worker,
          // A full four-heading report; partial replies trigger the salvage path.
          text: "## Summary\nEdited src/foo.ts as directed.\n## Findings\nnone\n## Blockers\nnone\n## Paths\nsrc/foo.ts",
        });
        session.harness.scenario.replyOnce("anthropic", {
          predicate: parent,
          text: "Collecting the worker.",
          toolCalls: [{ name: "wait_agents", args: { timeout_ms: 30_000 } }],
        });
        session.harness.scenario.replyOnce("anthropic", {
          predicate: parent,
          text: "The worker asked; I answered; it finished.",
        });

        const { events, reply } = await withMockedModuleDuring(
          import.meta.resolve("../src/session/assemble-runtime.js"),
          (real: typeof import("../src/session/assemble-runtime.js")) => ({
            ...real,
            assembleInferenceBase: async () => session.harness.deps,
          }),
          () => runUntilDone(session, "Run the asking job"),
        );

        const [parked, settled] = waitAgentsResults(events);
        expect(parked?.timed_out).toBe(false);
        const lane = parked?.results[0];
        expect(lane?.status).toBe("awaiting_director");
        expect(lane?.question).toBe("which file should I edit?");
        expect(lane?.question_id).toBeString();
        expect(settled?.results[0]?.status).toBe("done");
        expect(settled?.results[0]?.report).toContain("src/foo.ts");
        // The answer must reach the worker's next inference, not just unblock the call.
        const workerRequests = session.harness.scenario
          .matchedRequests()
          .filter((r) => RequestURL.assert(r).url.includes(WORKER_HOST));
        const last = workerRequests.at(-1);
        expect(await (last?.clone() as Request | undefined)?.text()).toContain(
          "edit src/foo.ts",
        );
        expect(reply).toContain("finished");
      } finally {
        await closeE2ESession(session);
      }
    },
    60000,
  );

  test.serial(
    "a real denied worker write is approved once with live correlation IDs and retried once",
    async () => {
      const fleetSessions = createSubAgentSessionStore();
      const session = await openFleetSession(
        fleetSessions,
        createPermissionGate({
          approvals: [
            { tool: "spawn_agent", pattern: "*" },
            { tool: "wait_agents", pattern: "*" },
            { tool: "approve_worker_call", pattern: "*" },
          ],
          interactive: true,
          skipPermissions: false,
          reactorGated: true,
          requestApproval: async () => ({ allow: true }),
        }),
      );
      try {
        const parent = fromHost("api.anthropic.com");
        const worker = fromHost(WORKER_HOST);
        const output = "approved.txt";
        const checkpoints: AuthorizationCheckpoint[] = [];
        let approvedRequestId: string | undefined;
        const replies = createRuntimeReplies(session);
        session.harness.scenario.replyOnce("anthropic", {
          predicate: parent,
          toolCalls: [
            {
              name: "spawn_agent",
              args: {
                description: "authorized write lane",
                prompt:
                  "Write approved.txt with approved, ask for authorization if denied, then report.",
                intent: "implement",
                success_criteria: ["approved.txt contains approved"],
              },
            },
          ],
        });
        session.harness.scenario.replyOnce("openai", {
          predicate: worker,
          toolCalls: [
            { name: "write_file", args: { path: output, content: "approved" } },
          ],
        });
        replies.replyOnce("openai", worker, ({ body }) => {
          const grantRequestId = /grant request ([\w-]+)/.exec(body)?.[1];
          if (grantRequestId === undefined) {
            throw new Error(
              `worker did not receive the denied-call grant marker: ${body}`,
            );
          }
          checkpoints.push("denied-write");
          return {
            toolCalls: [
              {
                name: "ask_director",
                args: {
                  question: "Please approve the denied write.",
                  grant_request_id: grantRequestId,
                  escalation: DIRECTOR_RESOLVABLE_ESCALATION,
                },
              },
            ],
          };
        });
        replies.replyOnce("openai", worker, ({ body }) =>
          body.includes("Parent approved the exact denied call")
            ? (checkpoints.push("authorized-retry"),
              {
                toolCalls: [
                  {
                    name: "write_file",
                    args: { path: output, content: "approved" },
                  },
                ],
              })
            : undefined,
        );
        replies.replyOnce("openai", worker, ({ body }) =>
          body.includes("wrote 8 bytes to")
            ? {
                text: "## Summary\nWrite completed.\n## Findings\nAuthorized retry succeeded.\n## Blockers\nNone.\n## Paths\napproved.txt",
              }
            : undefined,
        );
        session.harness.scenario.replyOnce("anthropic", {
          predicate: parent,
          toolCalls: [{ name: "wait_agents", args: { timeout_ms: 30_000 } }],
        });
        replies.replyOnce("anthropic", parent, ({ body }) => {
          const lane = fleetSessions.list()[0];
          const ask =
            lane === undefined ? undefined : fleetSessions.peekAsk(lane.id);
          const requestId = ask?.deniedCall?.requestId;
          const publicRequestId = waitAgentsGrantRequestId(body);
          if (
            lane === undefined ||
            ask?.questionId === undefined ||
            requestId === undefined ||
            publicRequestId === undefined
          ) {
            return undefined;
          }
          if (publicRequestId !== requestId) {
            throw new Error(
              `wait_agents grant_request_id ${publicRequestId} did not match pending ask ${requestId}`,
            );
          }
          checkpoints.push("asked-for-approval");
          approvedRequestId = publicRequestId;
          const args = {
            target: lane.id,
            question_id: ask.questionId,
            request_id: publicRequestId,
          };
          return { toolCalls: [{ name: "approve_worker_call", args }] };
        });
        replies.replyOnce("anthropic", parent, ({ body }) =>
          AUTHORIZED_STATUS.test(body)
            ? (checkpoints.push("approval-issued"),
              {
                toolCalls: [
                  { name: "wait_agents", args: { timeout_ms: 30_000 } },
                ],
              })
            : undefined,
        );
        replies.replyOnce("anthropic", parent, ({ body }) =>
          body.includes("Write completed")
            ? { text: "The approved worker write completed." }
            : undefined,
        );

        const result = await Promise.race([
          withMockedModuleDuring(
            import.meta.resolve("../src/session/assemble-runtime.js"),
            (real: typeof import("../src/session/assemble-runtime.js")) => ({
              ...real,
              assembleInferenceBase: async () => session.harness.deps,
            }),
            () => runUntilDone(session, "Run the authorized write"),
          ),
          replies.failed,
        ]);

        const waits = waitAgentsResults(result.events);
        const parked = waits[0];
        const settled = waits.at(-1);
        const lane = parked?.results[0];
        expect(checkpoints.slice(0, 2)).toEqual([
          "denied-write",
          "asked-for-approval",
        ]);
        expect(checkpoints.slice(2).sort()).toEqual([
          "approval-issued",
          "authorized-retry",
        ]);
        expect(lane?.status).toBe("awaiting_director");
        expect(lane?.question_id).toBeString();
        expect(lane?.grant_request_id).toBeString();
        expect(lane?.grant_request_id).toBe(approvedRequestId);
        expect(settled?.results[0]?.status).toBe("done");
        expect(await Bun.file(join(session.cwd, output)).text()).toBe(
          "approved",
        );
        const approvals = result.events.filter(
          (event) =>
            event.type === "tool.done" &&
            typeof event.data.result.content === "string" &&
            AUTHORIZED_STATUS.test(event.data.result.content),
        );
        expect(approvals).toHaveLength(1);
        const workerRequests = session.harness.scenario
          .matchedRequests()
          .filter(worker);
        expect(workerRequests).toHaveLength(4);
        expect(settled?.results[0]?.report).toContain(
          "Authorized retry succeeded.",
        );
        expect(result.reply).toBe("The approved worker write completed.");
      } finally {
        await closeE2ESession(session);
      }
    },
    60000,
  );

  test.serial(
    "a retryable first send triggers the outer retry and the worker recovers",
    async () => {
      const fleetSessions = createSubAgentSessionStore();
      const session = await openFleetSession(fleetSessions);
      try {
        const parent = fromHost("api.anthropic.com");
        const worker = fromHost(WORKER_HOST);
        session.harness.scenario.replyOnce("anthropic", {
          predicate: parent,
          text: "Dispatching a worker.",
          toolCalls: [
            {
              name: "spawn_agent",
              args: {
                description: "flaky lane",
                prompt: "Report when done.",
                intent: "explore",
              },
            },
          ],
        });
        // No tool ran, so the outer whole-send retry is not vetoed and fires once.
        session.harness.scenario.replyOnce("openai", {
          predicate: worker,
          text: "bad gateway",
          responseOpts: { status: 502 },
        });
        session.harness.scenario.replyOnce("openai", {
          predicate: worker,
          text: "## Summary\nrecovered on the second send\n## Findings\nnone\n## Blockers\nnone\n## Paths\nnone",
        });
        session.harness.scenario.replyOnce("anthropic", {
          predicate: parent,
          text: "Collecting the worker.",
          toolCalls: [{ name: "wait_agents", args: { timeout_ms: 30_000 } }],
        });
        session.harness.scenario.replyOnce("anthropic", {
          predicate: parent,
          text: "The worker recovered.",
        });

        const { events, reply } = await withMockedModuleDuring(
          import.meta.resolve("../src/session/assemble-runtime.js"),
          (real: typeof import("../src/session/assemble-runtime.js")) => ({
            ...real,
            assembleInferenceBase: async () => session.harness.deps,
          }),
          () => runUntilDone(session, "Run the flaky lane"),
        );

        const [settled] = waitAgentsResults(events);
        const workerRequests = session.harness.scenario
          .matchedRequests()
          .filter((r) => RequestURL.assert(r).url.includes(WORKER_HOST));
        expect(settled?.results[0]?.status).toBe("done");
        expect(settled?.results[0]?.report).toContain("recovered");
        expect(workerRequests).toHaveLength(2);
        expect(reply).toContain("recovered");
      } finally {
        await closeE2ESession(session);
      }
    },
    60000,
  );
});
