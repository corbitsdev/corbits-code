import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  generateSessionId,
  initSessionDir,
  sessionDir,
} from "../../../src/session/index.js";
import {
  loadState,
  saveState,
  type RunState,
} from "../../../src/session/state.js";

describe("resume persists interrupted before reopening running", () => {
  let cwd = "";
  let home = "";

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "corbits-resume-int-cwd-"));
    home = await mkdtemp(join(tmpdir(), "corbits-resume-int-home-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  test("stale running is persisted interrupted, then a resume reopen writes running", async () => {
    const sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);
    const original: RunState = {
      status: "running",
      turnsUsed: 6,
      task: "resume me",
      startedAt: 42,
      model: "test:model",
    };
    await saveState(cwd, sessionId, original, home);
    const runPath = join(sessionDir(cwd, sessionId, home), "run.json");
    const oldSec = Math.floor(Date.now() / 1000) - 20 * 60;
    await utimes(runPath, oldSec, oldSec);

    const aged = await loadState(cwd, sessionId, home, {
      nowMs: Date.now(),
      staleThresholdMs: 10 * 60_000,
    });
    expect(aged).toMatchObject({
      kind: "ok",
      state: { status: "interrupted", turnsUsed: 6 },
    });

    // Mirror prepareTUISession's reopen-as-running write after resume pick.
    await saveState(
      cwd,
      sessionId,
      {
        status: "running",
        turnsUsed: 6,
        task: "resume me",
        startedAt: 42,
        model: "test:model",
      },
      home,
    );
    const reopened = await loadState(cwd, sessionId, home, {
      persistAgeOut: false,
    });
    expect(reopened).toMatchObject({
      kind: "ok",
      state: { status: "running", turnsUsed: 6 },
    });
  });
});
