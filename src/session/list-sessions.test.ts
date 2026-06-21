import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { generateSessionId, initSessionDir, listSessions } from "./index.js";

let cwd = "";

beforeEach(async () => {
  cwd = join(tmpdir(), `intercode-list-sessions-${Date.now()}`);
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

test("listSessions includes TUI sessions with context/ but no run.json", async () => {
  const sessionId = generateSessionId();
  await initSessionDir(cwd, sessionId);
  const listed = await listSessions(cwd);
  expect(listed.some((s) => s.sessionId === sessionId)).toBe(true);
});

test("listSessions prefers run.json task title when present", async () => {
  const sessionId = generateSessionId();
  await initSessionDir(cwd, sessionId);
  await writeFile(
    join(cwd, ".agent-state", sessionId, "run.json"),
    JSON.stringify({
      status: "running",
      turnsUsed: 1,
      task: "fix resume",
      startedAt: 1_700_000_000_000,
    }),
  );
  const listed = await listSessions(cwd);
  const row = listed.find((s) => s.sessionId === sessionId);
  expect(row?.task).toBe("fix resume");
});