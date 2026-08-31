import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearActiveRun, getActiveRun, setActiveRun } from "../session/active-run.js";
import { finalizeRunState, loadState, saveState, type RunState } from "../session/state.js";
import { clearsActiveRun, type SnapshotKind } from "./runner.js";

describe("clearsActiveRun", () => {
  test("only the run-ending write clears the active-run handle", () => {
    expect(clearsActiveRun("run-end")).toBe(true);
    expect(clearsActiveRun("progress")).toBe(false);
    // The regression this pins: a /clear or /new rotation persists a
    // terminal "done" for the outgoing session, but the process lives on.
    // Clearing liveness here leaves every later session uncovered by the
    // crash handler, so a crash after the first rotation never writes a
    // terminal record and the session reads as "running" forever.
    expect(clearsActiveRun("session-rotation")).toBe(false);
  });
});

describe("a snapshot write dispatched by kind", () => {
  let cwd = "";
  let home = "";

  // Mirrors writeRunSnapshot's dispatch in runner.ts so the rule above is
  // exercised against the real state writers, not just asserted in isolation.
  const write = async (sessionId: string, state: RunState, kind: SnapshotKind): Promise<void> => {
    if (clearsActiveRun(kind)) {
      await finalizeRunState(cwd, sessionId, state, home);
      return;
    }
    await saveState(cwd, sessionId, state, home);
  };

  const runState = (over: Partial<RunState>): RunState => ({
    status: "running",
    turnsUsed: 0,
    task: "task",
    startedAt: 1,
    ...over,
  });

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "snapshot-kind-cwd-"));
    home = mkdtempSync(join(tmpdir(), "snapshot-kind-home-"));
  });

  afterEach(() => {
    clearActiveRun();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("a rotation still records the outgoing session but leaves the run crash-coverable", async () => {
    setActiveRun({ sessionId: "old", cwd, task: "task", startedAt: 1 });

    await write("old", runState({ status: "done", finishedAt: 10 }), "session-rotation");

    expect(await loadState(cwd, "old", home)).toMatchObject({
      kind: "ok",
      state: { status: "done" },
    });
    // The rotated-in session is repointed on the same handle, so the handle
    // must survive the write for the crash handler to have anything to close.
    expect(getActiveRun()).not.toBeNull();
  });

  test("the run-ending write records the session and disarms the handle", async () => {
    setActiveRun({ sessionId: "last", cwd, task: "task", startedAt: 1 });

    await write("last", runState({ status: "done", finishedAt: 20 }), "run-end");

    expect(await loadState(cwd, "last", home)).toMatchObject({
      kind: "ok",
      state: { status: "done" },
    });
    expect(getActiveRun()).toBeNull();
  });
});
