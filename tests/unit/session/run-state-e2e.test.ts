import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import { describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";

import { generateSessionId } from "../../../src/session/index.js";
import { createRunSink } from "../../../src/session/run-sink.js";
import { saveState, loadState, type RunState } from "../../../src/session/state.js";

// End-to-end coverage for the run.json turn-boundary snapshot fix (CL-5534):
// createRunSink, saveState, and loadState run for real against a temp
// session directory — nothing mocked. The snapshot cadence itself now lives
// in createRunSink's onTurnBoundarySnapshot callback (moved out of
// src/tui/runner.ts so a future renderer swap cannot silently drop it
// again), so these tests drive that callback exactly as production wiring
// does: nothing here calls saveState directly from the turn loop, only from
// inside onTurnBoundarySnapshot.

const noopHookManager = { dispatchPostTurn: () => undefined, getStatuses: () => [] };

function inferenceDone(): ReactorEmittedEvent {
  return {
    type: "inference.done",
    data: {
      turn: { content: [] },
      usage: {},
      source: "primary",
    },
  } as unknown as ReactorEmittedEvent;
}

function baseState(overrides: Partial<RunState>, turnsUsed: number): RunState {
  return {
    status: "running",
    turnsUsed,
    task: "e2e run-state test",
    startedAt: Date.now(),
    model: "test-provider:test-model",
    mcpServers: [],
    ...overrides,
  };
}

describe("run.json turn-boundary snapshots — end to end", () => {
  test("turnsUsed increments and is readable off disk after every turn, and status settles to done", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "corbits-run-state-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "corbits-run-state-home-"));
    const sessionId = generateSessionId();
    try {
      const writes: Promise<void>[] = [];
      const observed: number[] = [];
      const runSink = createRunSink({
        emitter: new EventEmitter(),
        hookManager: noopHookManager,
        onTurnBoundarySnapshot: () => {
          observed.push(runSink.getTurnCount());
          writes.push(
            saveState(
              cwd,
              sessionId,
              baseState({ status: "running" }, runSink.getTurnCount()),
              home,
            ),
          );
        },
      });

      for (let turn = 1; turn <= 4; turn++) {
        runSink.sink(inferenceDone());
      }
      await Promise.all(writes);

      // The snapshot callback must fire once per turn, not just once at the
      // end — that's the regression this test guards against.
      expect(observed).toEqual([1, 2, 3, 4]);

      const onDisk = await loadState(cwd, sessionId, home);
      expect(onDisk).toMatchObject({ kind: "ok", state: { turnsUsed: 4 } });

      runSink.sink({ type: "reactor.done", data: {} } as unknown as ReactorEmittedEvent);
      await saveState(
        cwd,
        sessionId,
        baseState({ status: "done", finishedAt: Date.now() }, runSink.getTurnCount()),
        home,
      );
      const finalState = await loadState(cwd, sessionId, home);
      expect(finalState).toMatchObject({ kind: "ok", state: { status: "done", turnsUsed: 4 } });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("20 rapid back-to-back turns with no settling delay serialize without dropping a write", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "corbits-run-state-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "corbits-run-state-home-"));
    const sessionId = generateSessionId();
    try {
      const writes: Promise<void>[] = [];
      const runSink = createRunSink({
        emitter: new EventEmitter(),
        hookManager: noopHookManager,
        onTurnBoundarySnapshot: () => {
          writes.push(
            saveState(
              cwd,
              sessionId,
              baseState({ status: "running" }, runSink.getTurnCount()),
              home,
            ),
          );
        },
      });

      // Fire all 20 turns back to back, with no await between them — the
      // per-session writeChains promise chain in src/session/state.ts is what
      // keeps the resulting writes ordered, not the caller awaiting each one
      // before starting the next.
      for (let turn = 1; turn <= 20; turn++) {
        runSink.sink(inferenceDone());
      }
      await Promise.all(writes);

      const finalState = await loadState(cwd, sessionId, home);
      expect(finalState).toMatchObject({ kind: "ok", state: { turnsUsed: 20 } });
      expect(runSink.getTurnCount()).toBe(20);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a late in-flight running write racing a done write never resurrects status to running", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "corbits-run-state-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "corbits-run-state-home-"));
    const sessionId = generateSessionId();
    try {
      let runningWrite: Promise<void> | undefined;
      const runSink = createRunSink({
        emitter: new EventEmitter(),
        hookManager: noopHookManager,
        onTurnBoundarySnapshot: () => {
          runningWrite = saveState(
            cwd,
            sessionId,
            baseState({ status: "running" }, runSink.getTurnCount()),
            home,
          );
        },
      });

      // The turn-boundary snapshot fires and is left un-awaited before the
      // terminal "done" write follows right behind it — this models a
      // straggler turn-boundary snapshot racing the close-out write.
      runSink.sink(inferenceDone());
      runSink.sink({ type: "reactor.done", data: {} } as unknown as ReactorEmittedEvent);
      const doneWrite = saveState(
        cwd,
        sessionId,
        baseState({ status: "done", finishedAt: Date.now() }, runSink.getTurnCount()),
        home,
      );

      await Promise.all([runningWrite, doneWrite]);

      const finalState = await loadState(cwd, sessionId, home);
      expect(finalState).toMatchObject({ kind: "ok", state: { status: "done" } });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
