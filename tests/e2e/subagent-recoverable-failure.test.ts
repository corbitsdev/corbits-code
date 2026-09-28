import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import type { RequestPredicate } from "@intx/inference-testing";

import { createSubAgentSessionStore } from "../../src/subagent/index.js";
import { withMockedModuleDuring } from "../helpers/mock-module.js";
import {
  closeE2ESession,
  e2ePermissionGate,
  openE2ESession,
  runUntilDone,
  seedFile,
  toolDoneEvents,
} from "./harness.js";

const RequestURL = type({ url: "string" });
const fromHost =
  (host: string): RequestPredicate =>
  (request) =>
    RequestURL.assert(request).url.includes(host);

// The worker's own model rides the same scripted fetch layer as the parent
// (assembleInferenceBase is mocked onto the session harness inside the turn)
// on a distinct baseURL, so predicates split parent and worker requests.
const WORKER_HOST = "worker.invalid";
const WORKER_PROVIDER = {
  providerName: "openai",
  baseURL: `https://${WORKER_HOST}/v1`,
  model: "test-model",
};

const WaitAgentsResult = type({
  results: type({
    agent_id: "string",
    status: "string",
    "continuable?": "boolean",
    "continue_with?": "string",
    "error?": "string",
  }).array(),
  timed_out: "boolean",
});

function waitAgentsResult(
  events: Parameters<typeof toolDoneEvents>[0],
): typeof WaitAgentsResult.infer {
  let callId: string | undefined;
  for (const event of events) {
    if (event.type === "tool.start" && event.data.call.name === "wait_agents") {
      callId = event.data.call.id;
      break;
    }
  }
  if (callId === undefined) throw new Error("wait_agents was never called");
  const done = toolDoneEvents(events).find(
    (event) => event.data.result.callId === callId,
  );
  if (done === undefined) throw new Error("wait_agents produced no result");
  return WaitAgentsResult.assert(JSON.parse(String(done.data.result.content)));
}

describe("e2e — recoverable worker failure does not stall the parent", () => {
  test.serial(
    "a worker that dies retryably after tool use reports failed+continuable",
    async () => {
      const fleetSessions = createSubAgentSessionStore();
      const session = await openE2ESession({
        permissionGate: e2ePermissionGate(),
        subAgent: {
          provider: WORKER_PROVIDER,
          sessions: fleetSessions,
          // Abort the inner retry outright — the production backoff waits
          // on the injected scheduler, which is inert under the harness.
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
        // The worker runs one real tool, then its inference dies retryably.
        // A tool having run vetoes the outer whole-send retry, so the
        // inner retry budget alone is consumed — a 5xx classifies
        // "retryable", which the mailbox marks recoverable. (429 would be
        // quota_exhausted and correctly NOT continuable.)
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
          import.meta.resolve("../../src/session/assemble-runtime.js"),
          (real: typeof import("../../src/session/assemble-runtime.js")) => ({
            ...real,
            assembleInferenceBase: async () => session.harness.deps,
          }),
          () => runUntilDone(session, "Run the flaky job"),
        );

        const result = waitAgentsResult(events);
        expect(result.timed_out).toBe(false);
        const lane = result.results[0];
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
});
