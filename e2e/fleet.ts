/**
 * Fleet scenario helpers shared by the subagent e2e files: a distinct worker
 * host splits parent and worker requests on the same scripted fetch layer,
 * and wait_agents results parse through arktype at the boundary.
 */

import { type } from "arktype";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { RequestPredicate } from "@intx/inference-testing";

import { toolDoneEvents } from "./harness.js";

const RequestURL = type({ url: "string" });
export const fromHost =
  (host: string): RequestPredicate =>
  (request) =>
    RequestURL.assert(request).url.includes(host);

export const WORKER_HOST = "worker.invalid";
export const WORKER_PROVIDER = {
  providerName: "openai",
  baseURL: `https://${WORKER_HOST}/v1`,
  model: "test-model",
};

export const WaitAgentsResult = type({
  results: type({
    agent_id: "string",
    status: "string",
    "continuable?": "boolean",
    "continue_with?": "string",
    "error?": "string",
    "question?": "string",
    "question_id?": "string",
    "report?": "string",
  }).array(),
  timed_out: "boolean",
});

/** Every wait_agents tool result in the event stream, in call order. */
export function waitAgentsResults(
  events: ReactorEmittedEvent[],
): (typeof WaitAgentsResult.infer)[] {
  const callIds = events.flatMap((event) =>
    event.type === "tool.start" && event.data.call.name === "wait_agents"
      ? [event.data.call.id]
      : [],
  );
  if (callIds.length === 0) throw new Error("wait_agents was never called");
  return callIds.map((callId) => {
    const done = toolDoneEvents(events).find(
      (event) => event.data.result.callId === callId,
    );
    if (done === undefined)
      throw new Error(`wait_agents call ${callId} produced no result`);
    return WaitAgentsResult.assert(
      JSON.parse(String(done.data.result.content)),
    );
  });
}
