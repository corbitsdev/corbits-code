import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import { createSubAgentSessionStore } from "../src/subagent/index.js";
import { waitAgentsToolDefinition } from "../src/subagent/agent-fleet.js";
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
  seedFile,
} from "./harness.js";

const RequestURL = type({ url: "string" });

describe("e2e — recoverable worker failure does not stall the parent", () => {
  test.serial(
    "wait_agents documents the continuable successor contract",
    () => {
      expect(waitAgentsToolDefinition.description).toContain("continuable");
    },
  );
  test.serial(
    "a worker that dies retryably after tool use reports failed+continuable",
    async () => {
      const fleetSessions = createSubAgentSessionStore();
      const session = await openE2ESession({
        permissionGate: e2ePermissionGate(),
        subAgent: {
          provider: WORKER_PROVIDER,
          sessions: fleetSessions,
          // Abort the inner retry; the injected scheduler is inert under the harness.
          outerRetryDelayMs: 0,
          retryPolicy: () => ({ kind: "abort" }),
        },
        mountWaitAgents: true,
        toolAvailability: {
          languageServerAvailable: false,
          waitAgentsMounted: true,
        },
      });
      try {
        seedFile(session, "marker.txt", "the marker content\n");
        const parent = fromHost("api.anthropic.com");
        const worker = fromHost(WORKER_HOST);

        session.harness.scenario.replyOnce("anthropic", {
          predicate: parent,
          text: "Dispatching a worker.",
          toolCalls: [
            {
              name: "spawn_agent",
              args: {
                description: "read the marker",
                prompt: "Read marker.txt and report its contents.",
                intent: "explore",
              },
            },
          ],
        });
        // One real tool runs, then inference dies retryably: the run vetoes
        // the outer retry, and a 5xx marks the lane recoverable.
        session.harness.scenario.replyOnce("openai", {
          predicate: worker,
          toolCalls: [{ name: "read", args: { path: "marker.txt" } }],
        });
        session.harness.scenario.replyOnce("openai", {
          predicate: worker,
          text: "upstream unavailable",
          responseOpts: { status: 503 },
        });
        session.harness.scenario.replyOnce("anthropic", {
          predicate: parent,
          text: "Collecting the worker.",
          toolCalls: [{ name: "wait_agents", args: { timeout_ms: 30_000 } }],
        });
        session.harness.scenario.replyOnce("anthropic", {
          predicate: parent,
          text: "The worker failed but the lane is recoverable.",
        });

        const { events, reply } = await withMockedModuleDuring(
          import.meta.resolve("../src/session/assemble-runtime.js"),
          (real: typeof import("../src/session/assemble-runtime.js")) => ({
            ...real,
            assembleInferenceBase: async () => session.harness.deps,
          }),
          () => runUntilDone(session, "Run the flaky job"),
        );

        const [result] = waitAgentsResults(events);
        expect(result?.timed_out).toBe(false);
        const lane = result?.results[0];
        expect(lane?.status).toBe("failed");
        expect(lane?.continuable).toBe(true);
        expect(lane?.continue_with).toBeString();
        expect(reply).toContain("recoverable");
      } finally {
        await closeE2ESession(session);
      }
    },
    60000,
  );
  test.serial(
    "a failed+continuable lane lets the parent spawn a successor sibling that runs to done",
    async () => {
      const fleetSessions = createSubAgentSessionStore();
      const session = await openE2ESession({
        permissionGate: e2ePermissionGate(),
        subAgent: {
          provider: WORKER_PROVIDER,
          sessions: fleetSessions,
          // Abort the inner retry; the injected scheduler is inert under the harness.
          outerRetryDelayMs: 0,
          retryPolicy: () => ({ kind: "abort" }),
        },
        mountWaitAgents: true,
        toolAvailability: {
          languageServerAvailable: false,
          waitAgentsMounted: true,
        },
      });
      try {
        seedFile(session, "marker.txt", "the marker content\n");
        const parent = fromHost("api.anthropic.com");
        const worker = fromHost(WORKER_HOST);

        session.harness.scenario.replyOnce("anthropic", {
          predicate: parent,
          text: "Dispatching a worker.",
          toolCalls: [
            {
              name: "spawn_agent",
              args: {
                description: "read the marker",
                prompt: "Read marker.txt and report its contents.",
                intent: "explore",
              },
            },
          ],
        });
        // First lane: one tool, then a retryable death — failed+continuable.
        session.harness.scenario.replyOnce("openai", {
          predicate: worker,
          toolCalls: [{ name: "read", args: { path: "marker.txt" } }],
        });
        session.harness.scenario.replyOnce("openai", {
          predicate: worker,
          text: "upstream unavailable",
          responseOpts: { status: 503 },
        });
        session.harness.scenario.replyOnce("anthropic", {
          predicate: parent,
          text: "Collecting the failed worker.",
          toolCalls: [{ name: "wait_agents", args: { timeout_ms: 30_000 } }],
        });
        // One successor sibling with the same brief.
        session.harness.scenario.replyOnce("anthropic", {
          predicate: parent,
          text: "Spawning one successor.",
          toolCalls: [
            {
              name: "spawn_agent",
              args: {
                description: "read the marker",
                prompt: "Read marker.txt and report its contents.",
                intent: "explore",
              },
            },
          ],
        });
        // A full four-heading report; partial replies trigger the salvage path.
        session.harness.scenario.replyOnce("openai", {
          predicate: worker,
          text: "## Summary\nThe marker holds the marker content.\n## Findings\nnone\n## Blockers\nnone\n## Paths\nmarker.txt",
        });
        session.harness.scenario.replyOnce("anthropic", {
          predicate: parent,
          text: "Collecting the successor.",
          toolCalls: [{ name: "wait_agents", args: { timeout_ms: 30_000 } }],
        });
        session.harness.scenario.replyOnce("anthropic", {
          predicate: parent,
          text: "The successor recovered the lane.",
        });

        const { events, reply } = await withMockedModuleDuring(
          import.meta.resolve("../src/session/assemble-runtime.js"),
          (real: typeof import("../src/session/assemble-runtime.js")) => ({
            ...real,
            assembleInferenceBase: async () => session.harness.deps,
          }),
          () => runUntilDone(session, "Run the flaky job to recovery"),
        );

        const [failed, settled] = waitAgentsResults(events);
        expect(failed?.timed_out).toBe(false);
        expect(failed?.results[0]?.status).toBe("failed");
        expect(failed?.results[0]?.continuable).toBe(true);
        expect(failed?.results[0]?.continue_with).toBeString();
        expect(settled?.timed_out).toBe(false);
        expect(settled?.results[0]?.status).toBe("done");
        expect(settled?.results[0]?.report).toContain("marker content");
        // A true sibling lane: a new agent, not a re-wait of the failed one.
        expect(settled?.results[0]?.agent_id).toBeString();
        expect(settled?.results[0]?.agent_id).not.toBe(
          failed?.results[0]?.agent_id,
        );
        const workerRequests = session.harness.scenario
          .matchedRequests()
          .filter((r) => RequestURL.assert(r).url.includes(WORKER_HOST));
        expect(workerRequests).toHaveLength(3);
        expect(reply).toContain("recovered the lane");
      } finally {
        await closeE2ESession(session);
      }
    },
    60000,
  );
});
