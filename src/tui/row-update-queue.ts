/**
 * Frame-coalesced tool-row updates (CL-6791 J3): the high-frequency row
 * repaints — elapsed clocks, agent progress, repeat-call coalescing —
 * accumulate here and apply once per renderer frame through the same flush
 * seam as the open streaming row (J1), instead of repainting the row per
 * event. Immediate seams (a result merging into its call) take the pending
 * row back out so they read and write the freshest state.
 */
import { replaceStreamRowAt } from "./shell/chrome.js";
import { streamRowAt } from "./shell/transcript.js";
import type { AppShell } from "./shell/internals.js";
import type { StreamRow } from "./stream.js";
import type { BridgeBag } from "./runtime-bridge.js";

/** Accumulated repaints by absolute row index; the latest snapshot wins. */
export type PendingRowUpdates = Map<number, StreamRow>;

export function scheduleRowUpdate(bag: BridgeBag, index: number, row: StreamRow): void {
  bag.pendingRowUpdates.set(index, row);
}

/** The freshest row an immediate seam should read for `index`, if any. */
export function takePendingRowUpdate(bag: BridgeBag, index: number): StreamRow | undefined {
  const row = bag.pendingRowUpdates.get(index);
  bag.pendingRowUpdates.delete(index);
  return row;
}

/** Drop updates a rollback truncated out of the log. */
export function dropPendingRowUpdatesFrom(bag: BridgeBag, boundary: number): void {
  for (const index of bag.pendingRowUpdates.keys()) {
    if (index >= boundary) bag.pendingRowUpdates.delete(index);
  }
}

/** Apply every accumulated row repaint; called once per renderer frame. */
export function applyPendingRowUpdates(shell: AppShell, bag: BridgeBag): void {
  if (bag.pendingRowUpdates.size === 0) return;
  const entries = [...bag.pendingRowUpdates];
  bag.pendingRowUpdates.clear();
  for (const [index, pending] of entries) {
    const live = streamRowAt(shell, index);
    // Evicted by the retention cap or truncated: nothing left to repaint.
    if (live === undefined) continue;
    // An expand/collapse toggle between schedule and flush owns the flag.
    const row =
      live.expanded !== undefined && live.expanded !== pending.expanded
        ? { ...pending, expanded: live.expanded }
        : pending;
    replaceStreamRowAt(shell, index, row);
  }
}
