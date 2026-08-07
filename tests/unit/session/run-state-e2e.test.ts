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
// session directory — nothing mocked. This is what now covers
// isRunSnapshotTurnBoundary's observable effect, since that predicate was
// un-exported from src/tui/runner.ts as a testability-only surface with a
// single production caller.

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
      const runSink = createRunSink({ emitter: new EventEmitter(), hookManager: noopHookManager });

      const observed: number[] = [];
      for (let turn = 1; turn <= 4; turn++) {
        runSink.sink(inferenceDone());
        await saveState(cwd, sessionId, baseState({ status: "running" }, runSink.getTurnCount()), home);
        const onDisk = await loadState(cwd, sessionId, home);
        expect(onDisk).not.toBeNull();
        observed.push(onDisk!.turnsUsed);
      }

      expect(observed).toEqual([1, 2, 3, 4]);

      runSink.sink({ type: "reactor.done", data: {} } as unknown as ReactorEmittedEvent);
      await saveState(
        cwd,
        sessionId,
        baseState({ status: "done", finishedAt: Date.now() }, runSink.getTurnCount()),
        home,
      );
      const finalState = await loadState(cwd, sessionId, home);
      expect(finalState?.status).toBe("done");
      expect(finalState?.turnsUsed).toBe(4);
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
      const runSink = createRunSink({ emitter: new EventEmitter(), hookManager: noopHookManager });

      // Fire all 20 turns and their snapshot writes back to back, with no
      // await between them — the per-session writeChains promise chain in
      // src/session/state.ts is what keeps these ordered rather than the
      // caller awaiting each one before starting the next.
      const writes: Promise<void>[] = [];
      for (let turn = 1; turn <= 20; turn++) {
        runSink.sink(inferenceDone());
        writes.push(saveState(cwd, sessionId, baseState({ status: "running" }, runSink.getTurnCount()), home));
      }
      await Promise.all(writes);

      const finalState = await loadState(cwd, sessionId, home);
      expect(finalState?.turnsUsed).toBe(20);
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
      const runSink = createRunSink({ emitter: new EventEmitter(), hookManager: noopHookManager });
      runSink.sink(inferenceDone());

      // Issue a "running" progress snapshot but do not await it before
      // issuing the terminal "done" write right behind it — this models a
      // straggler turn-boundary snapshot racing the close-out write.
      const runningWrite = saveState(
        cwd,
        sessionId,
        baseState({ status: "running" }, runSink.getTurnCount()),
        home,
      );
      runSink.sink({ type: "reactor.done", data: {} } as unknown as ReactorEmittedEvent);
      const doneWrite = saveState(
        cwd,
        sessionId,
        baseState({ status: "done", finishedAt: Date.now() }, runSink.getTurnCount()),
        home,
      );

      await Promise.all([runningWrite, doneWrite]);

      const finalState = await loadState(cwd, sessionId, home);
      expect(finalState?.status).toBe("done");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
