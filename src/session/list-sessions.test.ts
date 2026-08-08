import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { generateSessionId, initSessionDir, listSessions, sessionDir } from "./index.js";

let cwd = "";
let home = "";

beforeEach(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  cwd = join(tmpdir(), `corbits-list-sessions-${stamp}`);
  home = join(tmpdir(), `corbits-list-home-${stamp}`);
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("listSessions includes TUI sessions with context/ but no run.json", async () => {
  const sessionId = generateSessionId();
  await initSessionDir(cwd, sessionId, home);
  const listed = await listSessions(cwd, home);
  const row = listed.find((s) => s.sessionId === sessionId);
  expect(row).toBeDefined();
  expect(row?.task).toBe("Untitled session");
});

test("listSessions reports crashed, not running, for a session with no readable run.json", async () => {
  const sessionId = generateSessionId();
  await initSessionDir(cwd, sessionId, home);
  const listed = await listSessions(cwd, home);
  const row = listed.find((s) => s.sessionId === sessionId);
  expect(row?.status).not.toBe("running");
  expect(row?.status).toBe("crashed");
});

test("listSessions prefers run.json task title when present", async () => {
  const sessionId = generateSessionId();
  await initSessionDir(cwd, sessionId, home);
  await writeFile(
    join(sessionDir(cwd, sessionId, home), "run.json"),
    JSON.stringify({
      status: "running",
      turnsUsed: 1,
      task: "fix resume",
      startedAt: 1_700_000_000_000,
    }),
  );
  const listed = await listSessions(cwd, home);
  const row = listed.find((s) => s.sessionId === sessionId);
  expect(row?.task).toBe("fix resume");
});

// The goal subsystem persisted its own goal.json inside the session dir
// (src/session/goal-state.ts, removed). Nothing reads that file anymore, so
// a session dir left over from before the removal must still list cleanly —
// dropped on read, never fatal.
test("listSessions ignores a leftover goal.json from a pre-removal session", async () => {
  const sessionId = generateSessionId();
  await initSessionDir(cwd, sessionId, home);
  await writeFile(
    join(sessionDir(cwd, sessionId, home), "run.json"),
    JSON.stringify({
      status: "running",
      turnsUsed: 1,
      task: "pre-removal session",
      startedAt: 1_700_000_000_000,
    }),
  );
  await writeFile(
    join(sessionDir(cwd, sessionId, home), "goal.json"),
    JSON.stringify({
      status: "active",
      condition: "all tests pass",
      startedAt: 1_700_000_000_000,
      turnBudget: 0,
      turnsUsed: 3,
      mainTokens: 100,
      evalTokens: 20,
    }),
  );
  const listed = await listSessions(cwd, home);
  const row = listed.find((s) => s.sessionId === sessionId);
  expect(row).toBeDefined();
  expect(row?.task).toBe("pre-removal session");
});
