import type { ToolCall } from "@intx/types/runtime";

type Repeat = {
  calls: readonly ToolCall[];
  repeatCount: number;
  threshold: number;
};

// Corrective note for the doom-loop guard's warning turn (repeat count
// threshold−1): tells the model the exact call already ran unchanged, shows
// what else is on the wire, and points at the escape hatches — switching to a
// different tool already on the wire first, tool_search and replying to the
// operator as fallback. The wire list is read lazily so tool_search
// activations mid-run are reflected.
export function createDoomLoopCorrectiveNote(
  wireToolNames: () => readonly string[],
): (repeat: Repeat) => string {
  return ({ calls }) => {
    const looped = new Set(calls.map((c) => c.name));
    const repeated = [...looped].join(", ");
    const names = wireToolNames();
    const wire = names.join(", ");
    // Name one non-looped tool already on the wire as the first escape, so
    // the model switches instead of repeating. tool_search stays a fallback
    // rather than the example — it is named in the fallback sentence.
    const example = names.find(
      (name) => !looped.has(name) && name !== "tool_search",
    );
    const escape =
      example === undefined
        ? `Do not call this batch again — call tool_search to discover a ` +
          `different tool, or reply to the operator describing what you need.`
        : `Do not call this batch again — call a different tool already on ` +
          `the wire instead (for example ${example}). If none of those fits, ` +
          `call tool_search to discover a different tool or reply to the ` +
          `operator describing what you need.`;
    return (
      `Loop guard: this exact call (${repeated}) already ran with the same ` +
      `arguments and returned the same result — calling it again changes ` +
      `nothing. Tools currently on the wire: ${wire}. ${escape} The next ` +
      `identical repeat ends this run.`
    );
  };
}
