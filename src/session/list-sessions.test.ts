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

test("listSessions skips a session whose run.json is unreadable", async () => {
  const sessionId = generateSessionId();
  await initSessionDir(cwd, sessionId, home);
  await writeFile(join(sessionDir(cwd, sessionId, home), "run.json"), "{ not json");
  const listed = await listSessions(cwd, home);
  expect(listed.find((s) => s.sessionId === sessionId)).toBeUndefined();
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
  for (let i = 0; i < 8; i++) {
    const id = generateSessionId();
    await initSessionDir(cwd, id, home);
    await writeFile(join(sessionDir(cwd, id, home), "run.json"), '{ "turnsUsed": ');
  }

  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return orig(chunk, ...(rest as []));
  }) as typeof process.stderr.write;
  let listed: Awaited<ReturnType<typeof listSessions>> = [];
  try {
    listed = await listSessions(cwd, home);
  } finally {
    process.stderr.write = orig;
  }

  expect(listed.map((s) => s.sessionId)).toEqual([validId]);
  const text = chunks.join("");
  expect(text).not.toContain("ignoring unreadable");
  expect(text).not.toContain(home);
});
