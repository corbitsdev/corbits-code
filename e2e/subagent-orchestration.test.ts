import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import { createSubAgentSessionStore } from "../src/subagent/index.js";
import { withMockedModuleDuring } from "../testkit/mock-module.js";
import {
  fromHost,
  waitAgentsResults,
  WORKER_HOST,
  WORKER_PROVIDER,
} from "./fleet.js";
import {
  closeE2ESession,
  e2ePermissionGate,
  openE2ESession,
  runUntilDone,
} from "./harness.js";

const RequestURL = type({ url: "string" });

async function openFleetSession(
  sessions: ReturnType<typeof createSubAgentSessionStore>,
) {
  return openE2ESession({
    permissionGate: e2ePermissionGate(),
    subAgent: {
      provider: WORKER_PROVIDER,
      sessions,
      outerRetryDelayMs: 0,
      // The inner inference backoff waits on the injected scheduler, which
      // is inert under the harness — abort it outright and let the outer
      // whole-send retry policy own retry behavior instead.
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
              // The worker's session id is the spawn tool-call id — pin it
              // so send_input below has a stable target.
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
              args: { question: "which file should I edit?" },
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
          // A leaf report must carry the full four-heading envelope —
          // partial replies trigger the salvage/nudge path instead of done.
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
        // The answer must actually reach the worker's next inference, not
        // just unblock the parked call.
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
        // No tool call in the reply — nothing has executed, so the outer
        // whole-send retry is not vetoed and fires once with delayMs 0.
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
