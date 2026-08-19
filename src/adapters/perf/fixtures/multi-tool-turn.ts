/**
 * Golden fixture: one multi-tool turn with nested inference and permission wait.
 *
 * Privacy-safe: only allowlisted tags (tool_id, model_id, provider_id, tokens).
 * Fixed nanosecond times — no live clock. Durations:
 *
 *   turn t1                 0 → 5000
 *     inference i1        100 → 2100   (2000ns)
 *       inference.ttft    100 →  500   ( 400ns)
 *       inference.stream  500 → 2100   (1600ns)
 *     permission.wait     2100 → 2500  ( 400ns)
 *     tool k1             2500 → 3200  ( 700ns)  tool_id=read_file
 *     tool k2             3300 → 3800  ( 500ns)  tool_id=edit_file
 *
 * TTFT (400) < stream (1600). Two tools under the turn.
 */

import type { PerfSpan } from "../index.js";

function span(partial: {
  id: string;
  name: PerfSpan["name"];
  parentId?: string;
  startNs: bigint;
  endNs?: bigint;
  tags?: PerfSpan["tags"];
}): PerfSpan {
  const s: PerfSpan = {
    id: partial.id,
    name: partial.name,
    startNs: partial.startNs,
  };
  if (partial.parentId !== undefined) s.parentId = partial.parentId;
  if (partial.endNs !== undefined) s.endNs = partial.endNs;
  if (partial.tags !== undefined) s.tags = partial.tags;
  return s;
}

/** Synthetic multi-tool turn tree for rollup / assertion regression tests. */
export function multiToolTurnFixture(): PerfSpan[] {
  return [
    span({ id: "t1", name: "turn", startNs: 0n, endNs: 5000n, tags: { turn_id: "turn-1" } }),
    span({
      id: "i1",
      name: "inference",
      parentId: "t1",
      startNs: 100n,
      endNs: 2100n,
      tags: {
        provider_id: "test-provider",
        model_id: "test-model",
        input_tokens: 120,
        output_tokens: 40,
      },
    }),
    span({
      id: "ttft1",
      name: "inference.ttft",
      parentId: "i1",
      startNs: 100n,
      endNs: 500n,
    }),
    span({
      id: "stream1",
      name: "inference.stream",
      parentId: "i1",
      startNs: 500n,
      endNs: 2100n,
    }),
    span({
      id: "pw1",
      name: "permission.wait",
      parentId: "t1",
      startNs: 2100n,
      endNs: 2500n,
    }),
    span({
      id: "k1",
      name: "tool",
      parentId: "t1",
      startNs: 2500n,
      endNs: 3200n,
      tags: { tool_id: "read_file" },
    }),
    span({
      id: "k2",
      name: "tool",
      parentId: "t1",
      startNs: 3300n,
      endNs: 3800n,
      tags: { tool_id: "edit_file" },
    }),
  ];
}

/** Expected turn rollup for multiToolTurnFixture (locked golden values). */
export const MULTI_TOOL_TURN_GOLDEN = {
  turnId: "t1",
  turnNs: 5000,
  open: false,
  inferenceNs: 2000,
  toolNs: 1200,
  ttftNs: 400,
  streamNs: 1600,
  toolCount: 2,
} as const;
