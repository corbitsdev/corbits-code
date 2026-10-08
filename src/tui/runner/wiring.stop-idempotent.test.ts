import { describe, expect, test } from "bun:test";

import {
  createSubAgentSessionStore,
  type SubAgentSessionStore,
} from "../../subagent/session-store.js";
import { isLiveStrip } from "../../subagent/lifecycle.js";
import { cancelWorkersForStop } from "./wiring.js";

// CL-10149 Phase 3 — idempotent stop-then-quit (three-press Ctrl+C).
//
// The 2nd-press stop and the 3rd-press quit both drive `cancelWorkersForStop`
// (the affordance's onStopWorkers in Phase 4 wires the stop; the quit path
// runs it again through shutdownRuntime). Because `cancelAll` snapshots live
// sessions and leaves tombstones, a stop followed by a quit must cancel twice
// total, with the second call finding nothing live — no double cancel. The
// single-press pause (the interrupt path) must never call cancelAll at all.
// These assertions pin that idempotency at the `cancelWorkersForStop` unit
// boundary, before the affordance is wired into production (Phase 4).

interface StopHarness {
  store: SubAgentSessionStore;
  /** Live count seen at the start of every cancelAll call, in order. */
  cancelCalls: number[];
}

function liveStripCount(store: SubAgentSessionStore): number {
  return store.list().filter((session) => isLiveStrip(session.lifecycle))
    .length;
}

function harnessWithLiveWorkers(count: number): StopHarness {
  const store = createSubAgentSessionStore();
  const cancelCalls: number[] = [];
  const realCancelAll = store.cancelAll.bind(store);
  store.cancelAll = async (reason?: string): Promise<string[]> => {
    cancelCalls.push(liveStripCount(store));
    return realCancelAll(reason);
  };
  for (let i = 0; i < count; i++) {
    const session = store.start({
      description: `worker-${i}`,
      agentId: "w",
      brief: "b",
    });
    store.markRunning(session.id);
    store.registerCancel(session.id, () => undefined);
  }
  return { store, cancelCalls };
}

async function stopOnce(h: StopHarness): Promise<void> {
  // The production stop/quit path shares these exact deps (wiring.ts:296-300);
  // a fresh clear/bridge triple is fine per stop since neither affects the
  // cancelAll snapshot the idempotency claim is about.
  await cancelWorkersForStop({
    subAgentSessions: h.store,
    fleetRecords: { clear: () => undefined },
    bridge: { clearQueuedDelivery: () => undefined },
  });
}

describe("cancelWorkersForStop idempotency (CL-10149 Phase 3)", () => {
  test("stop then quit invokes cancelAll twice total; the second sees zero live sessions", async () => {
    const h = harnessWithLiveWorkers(2);
    expect(liveStripCount(h.store)).toBe(2);

    // 2nd press: stop the live workers (onStopWorkers → cancelWorkersForStop).
    await stopOnce(h);
    // 3rd press: quit (shutdownRuntime → cancelWorkersForStop again). All
    // sessions are already cancelled, so this must be a no-op for cancel.
    await stopOnce(h);

    // cancelAll ran exactly twice, not more.
    expect(h.cancelCalls).toHaveLength(2);
    expect(h.cancelCalls[0]).toBe(2);
    // The second snapshot sees nothing live — already-shutdown sessions skipped.
    expect(h.cancelCalls[1]).toBe(0);
    expect(liveStripCount(h.store)).toBe(0);
  });

  test("single-press pause never calls cancelAll", async () => {
    // The pause press must not drive the stop/quit path, so a worker that is
    // only paused stays live and cancelAll is never invoked (guards the
    // interrupt path, R4/R5).
    const h = harnessWithLiveWorkers(1);
    expect(liveStripCount(h.store)).toBe(1);
    expect(h.cancelCalls).toHaveLength(0);
    expect(liveStripCount(h.store)).toBe(1);
  });

  test("a lone stop on many live workers still cancels exactly once", async () => {
    const h = harnessWithLiveWorkers(3);
    await stopOnce(h);
    expect(h.cancelCalls).toHaveLength(1);
    expect(h.cancelCalls[0]).toBe(3);
    expect(liveStripCount(h.store)).toBe(0);
  });
});
