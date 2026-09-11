import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearActiveRun,
  setActiveRun,
  type RunStateHandle,
} from "./active-run.js";
import { generateSessionId, initSessionDir, sessionDir } from "./index.js";
import {
  ageStaleRunningState,
  RUN_STALE_THRESHOLD_MS,
  startRunHeartbeat,
} from "./run-liveness.js";
import { loadState, saveState, type RunState } from "./state.js";

function baseState(over: Partial<RunState> = {}): RunState {
  return {
    status: "running",
    turnsUsed: 2,
    task: "liveness",
    startedAt: 1_000,
    model: "test:model",
    ...over,
  };
}

describe("ageStaleRunningState", () => {
  test("ages parseable stale running to interrupted", () => {
    const aged = ageStaleRunningState(baseState(), 1_000, {
      nowMs: 1_000 + RUN_STALE_THRESHOLD_MS + 1,
      sessionId: "other",
    });
    expect(aged.status).toBe("interrupted");
    expect(aged.finishedAt).toBe(1_000);
  });

  test("does not age a fresh running record", () => {
    const aged = ageStaleRunningState(baseState(), 1_000, {
      nowMs: 1_000 + RUN_STALE_THRESHOLD_MS,
    });
    expect(aged.status).toBe("running");
  });

  test("does not age the active run owned by this process", () => {
    clearActiveRun();
    const sessionId = "live-session";
    const handle: RunStateHandle = {
      sessionId,
      cwd: "/tmp",
      task: "live",
      startedAt: 1,
      turnsUsed: 0,
    };
    setActiveRun(handle);
    try {
      const aged = ageStaleRunningState(baseState(), 1_000, {
        nowMs: 1_000 + RUN_STALE_THRESHOLD_MS + 1,
        sessionId,
      });
      expect(aged.status).toBe("running");
    } finally {
      clearActiveRun();
    }
  });
});

describe("startRunHeartbeat", () => {
  test("ticks while active and stops after teardown", async () => {
    let ticks = 0;
    let active = true;
    const stop = startRunHeartbeat({
      intervalMs: 20,
      shouldTick: () => active,
      tick: () => {
        ticks += 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 55));
    expect(ticks).toBeGreaterThan(0);
    const beforeStop = ticks;
    active = false;
    stop();
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(ticks).toBe(beforeStop);
  });
});

describe("loadState tmp recovery and stale aging", () => {
  let cwd = "";
  let home = "";

  beforeEach(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    cwd = await mkdtemp(join(tmpdir(), `corbits-liveness-cwd-${stamp}-`));
    home = await mkdtemp(join(tmpdir(), `corbits-liveness-home-${stamp}-`));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  test("prefers a newer parseable tmp over stale run.json by mtime", async () => {
    const sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);
    const dir = sessionDir(cwd, sessionId, home);
    const runPath = join(dir, "run.json");
    await saveState(cwd, sessionId, baseState({ task: "old-on-disk" }), home);
    const newer = baseState({ task: "newer-tmp", turnsUsed: 9 });
    const tmpPath = join(dir, `run.json.${process.pid}.recovery.tmp`);
    await writeFile(tmpPath, JSON.stringify(newer, null, 2));
    const older = Math.floor(Date.now() / 1000) - 20 * 60;
    const newerSec = Math.floor(Date.now() / 1000);
    await utimes(runPath, older, older);
    await utimes(tmpPath, newerSec, newerSec);

    const loaded = await loadState(cwd, sessionId, home, {
      persistAgeOut: false,
      staleThresholdMs: 10 * 60_000,
    });
    expect(loaded).toMatchObject({
      kind: "ok",
      state: { task: "newer-tmp", turnsUsed: 9 },
    });
  });

  test("does not prefer a newer parseable tmp over a fresh run.json", async () => {
    const sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);
    const dir = sessionDir(cwd, sessionId, home);
    await saveState(cwd, sessionId, baseState({ task: "canonical" }), home);
    const tmpPath = join(dir, `run.json.${process.pid}.inflight.tmp`);
    await writeFile(
      tmpPath,
      JSON.stringify(baseState({ task: "in-flight", turnsUsed: 9 }), null, 2),
    );
    const runPath = join(dir, "run.json");
    const older = Math.floor(Date.now() / 1000) - 30;
    const newerSec = Math.floor(Date.now() / 1000);
    await utimes(runPath, older, older);
    await utimes(tmpPath, newerSec, newerSec);

    const loaded = await loadState(cwd, sessionId, home, {
      persistAgeOut: false,
    });
    expect(loaded).toMatchObject({
      kind: "ok",
      state: { task: "canonical" },
    });
  });

  test("does not resurrect a newer running tmp over a fresh terminal run.json", async () => {
    const sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);
    const dir = sessionDir(cwd, sessionId, home);
    await saveState(
      cwd,
      sessionId,
      baseState({ status: "done", finishedAt: 999, task: "landed" }),
      home,
    );
    const tmpPath = join(dir, `run.json.${process.pid}.straggler.tmp`);
    await writeFile(
      tmpPath,
      JSON.stringify(baseState({ task: "straggler-running" }), null, 2),
    );
    const runPath = join(dir, "run.json");
    const landed = Math.floor(Date.now() / 1000);
    await utimes(runPath, landed, landed);
    await utimes(tmpPath, landed + 2, landed + 2);

    const loaded = await loadState(cwd, sessionId, home, {
      persistAgeOut: false,
    });
    expect(loaded).toMatchObject({
      kind: "ok",
      state: { status: "done", task: "landed" },
    });
  });

  test("recovers a parseable tmp when run.json is missing", async () => {
    const sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);
    const dir = sessionDir(cwd, sessionId, home);
    const tmpPath = join(dir, `run.json.${process.pid}.orphan.tmp`);
    await writeFile(
      tmpPath,
      JSON.stringify(baseState({ task: "orphan-tmp", turnsUsed: 4 }), null, 2),
    );

    const loaded = await loadState(cwd, sessionId, home, {
      persistAgeOut: false,
    });
    expect(loaded).toMatchObject({
      kind: "ok",
      state: { task: "orphan-tmp", turnsUsed: 4 },
    });
  });

  test("does not resurrect an older or equal-mtime tmp", async () => {
    const sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);
    const dir = sessionDir(cwd, sessionId, home);
    await saveState(cwd, sessionId, baseState({ task: "canonical" }), home);
    const tmpPath = join(dir, `run.json.${process.pid}.older.tmp`);
    await writeFile(
      tmpPath,
      JSON.stringify(baseState({ task: "stale-tmp" }), null, 2),
    );
    const runPath = join(dir, "run.json");
    const stamp = Math.floor(Date.now() / 1000);
    await utimes(runPath, stamp, stamp);
    await utimes(tmpPath, stamp - 30, stamp - 30);

    const loaded = await loadState(cwd, sessionId, home, {
      persistAgeOut: false,
    });
    expect(loaded).toMatchObject({
      kind: "ok",
      state: { task: "canonical" },
    });
  });

  test("does not prefer a malformed newer tmp", async () => {
    const sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);
    const dir = sessionDir(cwd, sessionId, home);
    await saveState(cwd, sessionId, baseState({ task: "canonical" }), home);
    const tmpPath = join(dir, `run.json.${process.pid}.bad.tmp`);
    await writeFile(tmpPath, "{ not-json");
    const runPath = join(dir, "run.json");
    const older = Math.floor(Date.now() / 1000) - 60;
    const newerSec = Math.floor(Date.now() / 1000);
    await utimes(runPath, older, older);
    await utimes(tmpPath, newerSec, newerSec);

    const loaded = await loadState(cwd, sessionId, home, {
      persistAgeOut: false,
    });
    expect(loaded).toMatchObject({
      kind: "ok",
      state: { task: "canonical" },
    });
  });

  test("sweeps aged temps but keeps a fresh in-flight tmp", async () => {
    const sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);
    const dir = sessionDir(cwd, sessionId, home);
    await saveState(cwd, sessionId, baseState(), home);
    const agedTmp = join(dir, `run.json.${process.pid}.aged.tmp`);
    const freshTmp = join(dir, `run.json.${process.pid}.fresh.tmp`);
    await writeFile(agedTmp, "{");
    await writeFile(freshTmp, "{");
    const agedSec = Math.floor(Date.now() / 1000) - 20 * 60;
    const freshSec = Math.floor(Date.now() / 1000);
    await utimes(agedTmp, agedSec, agedSec);
    await utimes(freshTmp, freshSec, freshSec);

    await loadState(cwd, sessionId, home, {
      nowMs: Date.now(),
      tmpSweepAgeMs: 10 * 60_000,
      persistAgeOut: false,
    });

    const { existsSync } = await import("node:fs");
    expect(existsSync(agedTmp)).toBe(false);
    expect(existsSync(freshTmp)).toBe(true);
  });

  test("ages stale running to interrupted and persists it", async () => {
    const sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);
    await saveState(cwd, sessionId, baseState(), home);
    const runPath = join(sessionDir(cwd, sessionId, home), "run.json");
    const oldSec = Math.floor(Date.now() / 1000) - 20 * 60;
    await utimes(runPath, oldSec, oldSec);

    const loaded = await loadState(cwd, sessionId, home, {
      nowMs: Date.now(),
      staleThresholdMs: 10 * 60_000,
    });
    expect(loaded).toMatchObject({
      kind: "ok",
      state: { status: "interrupted", turnsUsed: 2 },
    });
    const again = await loadState(cwd, sessionId, home, {
      persistAgeOut: false,
    });
    expect(again).toMatchObject({
      kind: "ok",
      state: { status: "interrupted" },
    });
  });

  test("missing and unreadable stay non-interrupted", async () => {
    const missingId = generateSessionId();
    expect(await loadState(cwd, missingId, home)).toEqual({ kind: "missing" });

    const badId = generateSessionId();
    await initSessionDir(cwd, badId, home);
    await writeFile(
      join(sessionDir(cwd, badId, home), "run.json"),
      "{ turnsUsed",
    );
    expect(await loadState(cwd, badId, home)).toEqual({ kind: "unreadable" });
  });
});
