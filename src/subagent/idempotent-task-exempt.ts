import { isSameTool } from "../agent/canonical-tool-name.js";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

/**
 * Doom-loop exemption for idempotent task bookkeeping. A batch is exempt only
 * when it is non-empty and every executed call is a task-bookkeeping tool
 * (`manage_tasks` — `isSameTool` folds the `todowrite` and `update_plan`
 * aliases onto that engine id).
 *
 * Repeating an identical task update is legitimate bookkeeping, not a runaway
 * loop: "finalize checklist" three times changes nothing and should not
 * abort an otherwise-finished run under the `fail-run` policy. This resets
 * the doom-loop streak (same mechanism as the poll exemption) so consecutive
 * task-only batches never accumulate toward the threshold, while any real
 * tool in the batch counts normally and always preserves the guard.
 */
export function isIdempotentTaskBatch(
  calls: readonly ToolCall[],
  _results: readonly ToolResult[],
): boolean {
  if (calls.length === 0) return false;
  return calls.every((call) => isSameTool(call.name, "manage_tasks"));
}