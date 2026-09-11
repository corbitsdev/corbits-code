import type { ToolCall } from "@intx/types/runtime";

type Repeat = {
  calls: readonly ToolCall[];
  repeatCount: number;
  threshold: number;
};

// Corrective note for the doom-loop guard's warning turn (repeat count
// threshold−1): tells the model the exact call already ran unchanged, shows
// what else is on the wire, and points at the two escape hatches. The wire
// list is read lazily so tool_search activations mid-run are reflected.
export function createDoomLoopCorrectiveNote(
  wireToolNames: () => readonly string[],
): (repeat: Repeat) => string {
  return ({ calls }) => {
    const repeated = [...new Set(calls.map((c) => c.name))].join(", ");
    const wire = wireToolNames().join(", ");
    return (
      `Loop guard: this exact call (${repeated}) already ran with the same ` +
      `arguments and returned the same result — calling it again changes ` +
      `nothing. Tools currently on the wire: ${wire}. Do not call this batch ` +
      `again — reply to the operator describing what you need, or call ` +
      `tool_search to discover a different tool. The next identical repeat ` +
      `ends this run.`
    );
  };
}
