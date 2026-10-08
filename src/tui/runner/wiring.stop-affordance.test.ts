import { describe, expect, test } from "bun:test";

import {
  createSubAgentSessionStore,
  type SubAgentSessionStore,
} from "../../subagent/session-store.js";
import { isLiveStrip } from "../../subagent/lifecycle.js";
import { createAppShell } from "../shell/index.js";
import {
  getShellStopAffordance,
  setShellExitHandler,
  setShellStopAffordance,
} from "../shell/internals.js";
import { handleCtrlC } from "../shell/keys.js";
import { withTestRenderer } from "../harness.js";
import { buildShellStopAffordance } from "./wiring.js";

// CL-10149 Phase 4 -- the integration half of Phase 3 deferred here.
//
// The runner wires the REAL stop affordance into the shell inside
// wirePostStartup via buildShellStopAffordance: the affordance's
// liveWorkerCount reports the underlying session store's live fleet and its
// onStopWorkers drives the production `cancelWorkersForStop` closure. This test
// proves that end-to-end against a harnessed store: a 2nd Ctrl+C press stops
// the live workers and the app STAYS RUNNING (no exit), and liveWorkerCount
// reports the harnessed store's live fleet before and after the stop.

function liveStripCount(store: SubAgentSessionStore): number {
  return store.list().filter((session) => isLiveStrip(session.lifecycle))
    .length;
}

function harnessWithLiveWorkers(count: number): SubAgentSessionStore {
  const store = createSubAgentSessionStore();
  for (let i = 0; i < count; i++) {
    const session = store.start({
      description: `worker-${i}`,
      agentId: "w",
      brief: "b",
    });
    store.markRunning(session.id);
    store.registerCancel(session.id, () => undefined);
  }
  return store;
}

describe("shell stop affordance wiring (CL-10149 Phase 4)", () => {
  test("stop press drives real cancelWorkersForStop; app stays running; count is the store's live fleet", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "busy",
      });
      let exits = 0;
      setShellExitHandler(shell, () => {
        exits += 1;
      });

      const store = harnessWithLiveWorkers(2);
      const bridge = { clearQueuedDelivery: () => undefined };
      // The production dep shapes feed cancelWorkersForStop; fleetRecords is
      // cleared after a stop so the idle-with-fleet gauge drops.
      const fleetRecords = { clear: () => undefined };
      const affordance = buildShellStopAffordance(
        { shell, bridge },
        { subAgentSessions: store, toolset: { fleetRecords } },
      );
      // The runner's wirePostStartup registers the affordance on the shell;
      // mirror that so the key machine's readStopAffordance sees it.
      setShellStopAffordance(shell, affordance);
      try {
        // The affordance is registered on the shell as production would.
        expect(getShellStopAffordance(shell)).toBe(affordance);
        // Before any press, liveWorkerCount reflects the harnessed store's fleet.
        expect(affordance.liveWorkerCount()).toBe(2);

        // 1st press arms (pause); app neither stops workers nor exits.
        handleCtrlC(shell, 0);
        expect(affordance.liveWorkerCount()).toBe(2);
        expect(exits).toBe(0);
        expect(liveStripCount(store)).toBe(2);

        // 2nd press inside the window stops the live workers via the real
        // cancelWorkersForStop closure -- app STAYS RUNNING (no exit).
        handleCtrlC(shell, 1);
        expect(liveStripCount(store)).toBe(0);
        expect(exits).toBe(0);

        // liveWorkerCount now reports the drained store.
        expect(affordance.liveWorkerCount()).toBe(0);

        // 3rd press quits (two-press preserved for an empty fleet).
        handleCtrlC(shell, 2);
        expect(exits).toBe(1);
        expect(liveStripCount(store)).toBe(0);
      } finally {
        shell.dispose();
      }
    });
  });

  test("no live workers: a 2nd press quits, onStopWorkers never cancels", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "busy",
      });
      let exits = 0;
      setShellExitHandler(shell, () => {
        exits += 1;
      });

      const store = createSubAgentSessionStore();
      const affordance = buildShellStopAffordance(
        { shell, bridge: { clearQueuedDelivery: () => undefined } },
        { subAgentSessions: store, toolset: { fleetRecords: undefined } },
      );
      setShellStopAffordance(shell, affordance);
      try {
        expect(affordance.liveWorkerCount()).toBe(0);
        handleCtrlC(shell, 0);
        handleCtrlC(shell, 1);
        expect(exits).toBe(1);
        // The stop affordance is still the real one; live count stays zero.
        expect(getShellStopAffordance(shell)).toBe(affordance);
      } finally {
        shell.dispose();
      }
    });
  });
});
