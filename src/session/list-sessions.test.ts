import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { generateSessionId, initSessionDir, listSessions, sessionDir } from "./index.js";
import { withFileLogSink } from "../../tests/helpers/file-log-sink.js";

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

test("listSessions skips a session whose run.json is unreadable", async () => {
  const sessionId = generateSessionId();
  await initSessionDir(cwd, sessionId, home);
  await writeFile(join(sessionDir(cwd, sessionId, home), "run.json"), "{ not json");
  await withFileLogSink(async () => {
    const listed = await listSessions(cwd, home);
    expect(listed.find((s) => s.sessionId === sessionId)).toBeUndefined();
  });
});

test("listSessions stays silent when many sibling run.json files are unreadable", async () => {
  const validId = generateSessionId();
  await initSessionDir(cwd, validId, home);
  await writeFile(
    join(sessionDir(cwd, validId, home), "run.json"),
    JSON.stringify({
      status: "running",
      turnsUsed: 1,
      task: "keep me",
      startedAt: 1_700_000_000_000,
    }),
  );
  const unreadablePaths: string[] = [];
  for (let i = 0; i < 8; i++) {
    const id = generateSessionId();
    await initSessionDir(cwd, id, home);
    const runPath = join(sessionDir(cwd, id, home), "run.json");
    unreadablePaths.push(runPath);
    await writeFile(runPath, '{ "turnsUsed": ');
  }

  let listed: Awaited<ReturnType<typeof listSessions>> = [];
  const logged = await withFileLogSink(async () => {
    listed = await listSessions(cwd, home);
  });

  expect(listed.map((s) => s.sessionId)).toEqual([validId]);
  expect(logged).toContain("corrupt JSON");
  for (const runPath of unreadablePaths) {
    expect(logged).toContain(runPath);
  }
});

test("listSessions includes a failed run that recorded an error", async () => {
  const sessionId = generateSessionId();
  await initSessionDir(cwd, sessionId, home);
  await writeFile(
    join(sessionDir(cwd, sessionId, home), "run.json"),
    JSON.stringify({
      status: "failed",
      turnsUsed: 2,
      task: "failed work",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_005_000,
      error: "Cycle commit failed\nhook dump: pre-commit rejected",
    }),
  );
  const listed = await listSessions(cwd, home);
  const row = listed.find((s) => s.sessionId === sessionId);
  expect(row?.status).toBe("failed");
  expect(row?.task).toBe("failed work");
});

test("listSessions includes a crashed run that recorded an error", async () => {
  const sessionId = generateSessionId();
  await initSessionDir(cwd, sessionId, home);
  await writeFile(
    join(sessionDir(cwd, sessionId, home), "run.json"),
    JSON.stringify({
      status: "crashed",
      turnsUsed: 1,
      task: "crashed work",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_005_000,
      error: "uncaughtException: boom",
    }),
  );
  const listed = await listSessions(cwd, home);
  const row = listed.find((s) => s.sessionId === sessionId);
  expect(row?.status).toBe("crashed");
  expect(row?.task).toBe("crashed work");
});

test("listSessions stays silent when many sibling runs failed with an error", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    const id = generateSessionId();
    ids.push(id);
    await initSessionDir(cwd, id, home);
    await writeFile(
      join(sessionDir(cwd, id, home), "run.json"),
      JSON.stringify({
        status: "failed",
        turnsUsed: 1,
        task: `failed ${i}`,
        startedAt: 1_700_000_000_000 + i,
        finishedAt: 1_700_000_005_000 + i,
        error: "Cycle commit failed\nhook dump",
      }),
    );
  }

  let listed: Awaited<ReturnType<typeof listSessions>> = [];
  const logged = await withFileLogSink(async () => {
    listed = await listSessions(cwd, home);
  });

  expect(listed.map((s) => s.sessionId).sort()).toEqual([...ids].sort());
  expect(listed.every((s) => s.status === "failed")).toBe(true);
  expect(logged).not.toContain("unreadable session state");
  expect(logged).not.toContain(home);
});
