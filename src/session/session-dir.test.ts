import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  generateSessionId,
  initSessionDir,
  legacySessionDir,
  listSessions,
  migrateLegacySessionIfNeeded,
  sessionDir,
} from "./index.js";

let cwd = "";
let home = "";

beforeEach(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  cwd = join(tmpdir(), `corbits-session-dir-${stamp}`);
  home = join(tmpdir(), `corbits-session-home-${stamp}`);
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("initSessionDir writes under the global projects tree, not the repo", async () => {
  const sessionId = generateSessionId();
  const dir = await initSessionDir(cwd, sessionId, home);
  expect(dir).toBe(sessionDir(cwd, sessionId, home));
  expect(dir.startsWith(join(home, ".corbits", "projects"))).toBe(true);
  expect(existsSync(join(dir, "context"))).toBe(true);
  expect(existsSync(join(cwd, ".agent-state", sessionId))).toBe(false);
});

test("migrateLegacySessionIfNeeded moves in-repo sessions into the global tree", async () => {
  const sessionId = generateSessionId();
  const legacy = legacySessionDir(cwd, sessionId);
  await mkdir(join(legacy, "context"), { recursive: true });
  await writeFile(
    join(legacy, "run.json"),
    JSON.stringify({
      status: "running",
      turnsUsed: 2,
      task: "legacy task",
      startedAt: 1_700_000_000_000,
    }),
  );

  const dir = await migrateLegacySessionIfNeeded(cwd, sessionId, home);
  expect(dir).toBe(sessionDir(cwd, sessionId, home));
  expect(existsSync(dir)).toBe(true);
  expect(existsSync(legacy)).toBe(false);
  const raw = await readFile(join(dir, "run.json"), "utf8");
  expect(JSON.parse(raw).task).toBe("legacy task");
});

test("listSessions finds legacy sessions and migrates them", async () => {
  const sessionId = generateSessionId();
  const legacy = legacySessionDir(cwd, sessionId);
  await mkdir(join(legacy, "context"), { recursive: true });
  await writeFile(
    join(legacy, "run.json"),
    JSON.stringify({
      status: "done",
      turnsUsed: 1,
      task: "from legacy",
      startedAt: 1_700_000_000_000,
    }),
  );

  const listed = await listSessions(cwd, home);
  const row = listed.find((s) => s.sessionId === sessionId);
  expect(row?.task).toBe("from legacy");
  expect(existsSync(sessionDir(cwd, sessionId, home))).toBe(true);
  expect(existsSync(legacy)).toBe(false);
});
