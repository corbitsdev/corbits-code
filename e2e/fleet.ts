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
    "grant_request_id?": "string",
    "report?": "string",
  }).array(),
  timed_out: "boolean",
});

/**
 * A scenario has to approve the grant while it builds the parent's next reply,
 * before `runUntilDone` hands back any events, so the id comes from the
 * inference request body, where the provider nests each tool result as a
 * JSON string.
 */
export function waitAgentsGrantRequestId(body: string): string | undefined {
  const payload = JSON.parse(body) as unknown;
  for (const content of serializedContents(payload)) {
    const result = WaitAgentsResult(content);
    if (result instanceof type.errors) continue;
    const grantRequestId = result.results.find(
      (lane) => lane.grant_request_id !== undefined,
    )?.grant_request_id;
    if (grantRequestId !== undefined) return grantRequestId;
  }
  return undefined;
}

function serializedContents(value: unknown): unknown[] {
  if (typeof value === "string") {
    try {
      return [JSON.parse(value)];
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap(serializedContents);
  if (value !== null && typeof value === "object")
    return Object.values(value).flatMap(serializedContents);
  return [];
}

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
