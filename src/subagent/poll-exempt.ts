import { type } from "arktype";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { isLiveWaitStatus, type WaitJSONStatus } from "./lifecycle.js";

const WaitAgentsPayload = type({
  "timed_out?": "boolean",
  "results?": type({ status: "string" }).array(),
});

const ShellCollectPayload = type({
  status: "string",
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

function isShellCollectPending(payload: unknown): boolean {
  const parsed = ShellCollectPayload(payload);
  if (parsed instanceof type.errors) return false;
  return parsed.status === "running";
}

/**
 * Doom-loop liveness policy for poll tools. A batch is exempt only when every
 * call is a known poll (`wait_agents`, `shell_collect`) and every result
 * still shows pending — a timed-out or live-status wait, a `running` collect.
 * Anything else (terminal polls, non-poll calls, mixed batches, unparseable
 * output) returns false so the guard counts the batch normally.
 */
export function isPollOnlyPendingBatch(
  calls: readonly ToolCall[],
  results: readonly ToolResult[],
): boolean {
  if (calls.length === 0 || results.length !== calls.length) return false;
  return calls.every((call, index) => {
    const result = results[index];
    if (result === undefined) return false;
    if (call.name !== "wait_agents" && call.name !== "shell_collect") {
      return false;
    }
    const payload = resultPayload(result);
    if (payload === undefined) return false;
    return call.name === "wait_agents"
      ? isWaitAgentsPending(payload)
      : isShellCollectPending(payload);
  });
}
