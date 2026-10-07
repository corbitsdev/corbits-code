import { isSameTool } from "../agent/canonical-tool-name.js";
import { type } from "arktype";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { isLiveWaitStatus, type WaitJSONStatus } from "./lifecycle.js";

const WaitAgentsPayload = type({
  "timed_out?": "boolean",
  "results?": type({ status: "string" }).array(),
});

function resultPayload(result: ToolResult): unknown {
  if (typeof result.content !== "string") return result.content;
  try {
    return JSON.parse(result.content) as unknown;
  } catch {
    return undefined;
  }
}

function isWaitAgentsPending(payload: unknown): boolean {
  const parsed = WaitAgentsPayload(payload);
  if (parsed instanceof type.errors) return false;
  if (parsed.timed_out === true) return true;
  return (parsed.results ?? []).some((entry) =>
    isLiveWaitStatus(entry.status as WaitJSONStatus),
  );
}

/**
 * Liveness policy for poll tools: a batch is exempt only when every call is a
 * known poll (`wait_agents`) and every result still shows pending — a
 * timed-out or live-status wait. Anything else (terminal polls, non-poll
 * calls, mixed batches, unparseable output) counts the batch normally so the
 * guard can fire.
 */
export function isPollOnlyPendingBatch(
  calls: readonly ToolCall[],
  results: readonly ToolResult[],
): boolean {
  if (calls.length === 0 || results.length !== calls.length) return false;
  return calls.every((call, index) => {
    const result = results[index];
    if (result === undefined) return false;
    if (!isSameTool(call.name, "wait_agents")) return false;
    const payload = resultPayload(result);
    if (payload === undefined) return false;
    return isWaitAgentsPending(payload);
  });
}
