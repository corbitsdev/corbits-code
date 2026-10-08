/**
 * Pure registry tests for the Phase 1 CL-10149 follow-up stop affordance
 * (src/tui/shell/internals.ts). These pin the WeakMap-backed
 * set/get round-trip, the unset behavior, and per-shell isolation so the
 * second-press stop seam has an observable contract before Phase 2 wires it
 * into handleCtrlC.
 */
import { describe, expect, test } from "bun:test";

import { withTestRenderer, type Harness } from "../harness.js";
import { createAppShell } from "./index.js";
import { N_SUBAGENT_RUNNING_NOTE_PREFIX, readStopAffordance } from "./keys.js";
import {
  getShellStopAffordance,
  setShellStopAffordance,
  type ShellStopAffordance,
} from "./internals.js";

function makeAffordance(workerCount = 2): ShellStopAffordance {
  let stopped = 0;
  return {
    liveWorkerCount: () => workerCount,
    onStopWorkers: () => {
      stopped += 1;
    },
  };
}

describe("shell stop affordance registry", () => {
  test("exports the shared count-aware note prefix", () => {
    // Phase 5 builds the 1st-press note from this constant so the wording has
    // one home; pinning it here keeps it consumed and quarantines a rename.
    expect(N_SUBAGENT_RUNNING_NOTE_PREFIX).toBe("sub-agent(s) running — ");
  });

  test("set then get round-trips the affordance", async () => {
    await withTestRenderer(async (h: Harness) => {
      const shell = createAppShell(h.renderer, { wireKeys: false });
      try {
        const affordance = makeAffordance(3);
        setShellStopAffordance(shell, affordance);

        const got = getShellStopAffordance(shell);
        expect(got).toBe(affordance);
        expect(got?.liveWorkerCount()).toBe(3);
        expect(got?.onStopWorkers).toBe(affordance.onStopWorkers);
      } finally {
        shell.dispose();
      }
    });
  });

  test("getting an unregistered shell returns undefined", async () => {
    await withTestRenderer(async (h: Harness) => {
      const shell = createAppShell(h.renderer, { wireKeys: false });
      try {
        expect(getShellStopAffordance(shell)).toBeUndefined();
      } finally {
        shell.dispose();
      }
    });
  });

  test("unsetting a registered affordance returns undefined afterwards", async () => {
    await withTestRenderer(async (h: Harness) => {
      const shell = createAppShell(h.renderer, { wireKeys: false });
      try {
        setShellStopAffordance(shell, makeAffordance());
        expect(getShellStopAffordance(shell)).toBeDefined();
        setShellStopAffordance(shell, undefined);
        expect(getShellStopAffordance(shell)).toBeUndefined();
      } finally {
        shell.dispose();
      }
    });
  });

  test("readStopAffordance defaults an unregistered shell (count 0, no-op onStop)", async () => {
    await withTestRenderer(async (h: Harness) => {
      const shell = createAppShell(h.renderer, { wireKeys: false });
      try {
        const { count, onStop } = readStopAffordance(shell);
        // Unregistered shell stays on today's two-press contract.
        expect(count).toBe(0);
        // No-op must be safe to call and return undefined (not a Promise).
        expect(onStop()).toBeUndefined();
      } finally {
        shell.dispose();
      }
    });
  });

  test("readStopAffordance mirrors a registered affordance's count and callback", async () => {
    await withTestRenderer(async (h: Harness) => {
      const shell = createAppShell(h.renderer, { wireKeys: false });
      try {
        const affordance = makeAffordance(3);
        setShellStopAffordance(shell, affordance);
        const { count, onStop } = readStopAffordance(shell);
        expect(count).toBe(3);
        // The callback is the registered one, not the default no-op.
        expect(onStop).toBe(affordance.onStopWorkers);
      } finally {
        shell.dispose();
      }
    });
  });

  test("two shells do not share affordances (WeakMap isolation)", async () => {
    await withTestRenderer(async (ha: Harness) => {
      await withTestRenderer(async (hb: Harness) => {
        const a = createAppShell(ha.renderer, { wireKeys: false });
        const b = createAppShell(hb.renderer, { wireKeys: false });
        try {
          const affordanceA = makeAffordance(4);
          setShellStopAffordance(a, affordanceA);

          // b stays unregistered even though a was set.
          expect(getShellStopAffordance(a)).toBe(affordanceA);
          expect(getShellStopAffordance(b)).toBeUndefined();

          // Setting a different affordance on b does not disturb a.
          const affordanceB = makeAffordance(9);
          setShellStopAffordance(b, affordanceB);
          expect(getShellStopAffordance(a)).toBe(affordanceA);
          expect(getShellStopAffordance(b)).toBe(affordanceB);
        } finally {
          a.dispose();
          b.dispose();
        }
      });
    });
  });
});
