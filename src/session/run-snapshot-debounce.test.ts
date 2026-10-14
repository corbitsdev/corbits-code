import { describe, expect, test } from "bun:test";

import { createTempDirs } from "../../testkit/temporary-dirs.js";
import { generateSessionId } from "./index.js";
import {
  createRunSnapshotDebouncer,
  loadState,
  saveState,
  type RunState,
} from "./state.js";

function snap(turnsUsed: number): RunState {
  return {
    status: "running",
    turnsUsed,
    task: "debounce test",
    startedAt: 1,
    model: "test-provider:test-model",
    mcpServers: [],
  };
}

describe("createRunSnapshotDebouncer (CL-10667)", () => {
  test("a burst of schedules behind one window lands as one write", async () => {
    const { cwd, home, cleanup } = createTempDirs(
      "corbits-debounce-cwd-",
      "corbits-debounce-home-",
    );
    const sessionId = generateSessionId();
    try {
      let turnsUsed = 0;
      const debouncer = createRunSnapshotDebouncer({
        write: async () => {
          turnsUsed += 1;
          await saveState(cwd, sessionId, snap(turnsUsed), home);
        },
        intervalMs: 20,
      });

      for (let i = 0; i < 10; i++) debouncer.schedule();
      // The timer fires the coalesced batch once the window elapses.
      await new Promise((resolve) => setTimeout(resolve, 120));

      const onDisk = await loadState(cwd, sessionId, home);
      expect(onDisk).toMatchObject({ kind: "ok", state: { turnsUsed: 1 } });
    } finally {
      cleanup();
    }
  });

  test("flush runs a pending write immediately; a clean flush writes nothing", async () => {
    let writes = 0;
    const debouncer = createRunSnapshotDebouncer({
      write: async () => {
        writes += 1;
      },
      intervalMs: 60_000, // armed but never able to fire on its own
    });

    debouncer.schedule();
    await debouncer.flush();
    expect(writes).toBe(1);
    // Nothing pending: flush is a no-op, not a second write.
    await debouncer.flush();
    expect(writes).toBe(1);
  });

  test("flush after the timer already fired is a no-op", async () => {
    let writes = 0;
    const debouncer = createRunSnapshotDebouncer({
      write: async () => {
        writes += 1;
      },
      intervalMs: 15,
    });

    debouncer.schedule();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await debouncer.flush();
    expect(writes).toBe(1);
  });
});
