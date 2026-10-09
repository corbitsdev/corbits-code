import { isSameTool } from "../agent/canonical-tool-name.js";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

/**
 * Doom-loop exemption for idempotent task bookkeeping. A batch is exempt only
 * when it is non-empty and every call is a task-bookkeeping tool
 * (`manage_tasks` — `isSameTool` folds `todowrite` and `update_plan`).
 * Mixed batches return false so the guard counts them normally.
 */
export function isIdempotentTaskBatch(
  calls: readonly ToolCall[],
  _results: readonly ToolResult[],
): boolean {
  if (calls.length === 0) return false;
  return calls.every((call) => isSameTool(call.name, "manage_tasks"));
}
