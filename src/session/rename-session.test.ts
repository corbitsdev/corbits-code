import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { generateSessionId, initSessionDir, renameSession, sessionDir } from "./index.js";
import { loadState } from "./state.js";

let cwd = "";
let home = "";

beforeEach(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  cwd = join(tmpdir(), `corbits-rename-session-${stamp}`);
  home = join(tmpdir(), `corbits-rename-home-${stamp}`);
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("renameSession updates task on a readable run.json and preserves other fields", async () => {
  const sessionId = generateSessionId();
  await initSessionDir(cwd, sessionId, home);
  await writeFile(
    join(sessionDir(cwd, sessionId, home), "run.json"),
    JSON.stringify({
      status: "done",
      turnsUsed: 4,
      task: "old name",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_100_000,
      model: "provider:model",
    }),
  );

  await renameSession(cwd, sessionId, "new name", home);

  const loaded = await loadState(cwd, sessionId, home);
  expect(loaded).toEqual({
    kind: "ok",
    state: {
      status: "done",
      turnsUsed: 4,
      task: "new name",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_100_000,
      model: "provider:model",
    },
  });
});

test("renameSession creates a running record when run.json is missing", async () => {
  const sessionId = generateSessionId();
  await initSessionDir(cwd, sessionId, home);

  await renameSession(cwd, sessionId, "named session", home);

  const loaded = await loadState(cwd, sessionId, home);
  expect(loaded.kind).toBe("ok");
  if (loaded.kind !== "ok") return;
  expect(loaded.state.status).toBe("running");
  expect(loaded.state.turnsUsed).toBe(0);
  expect(loaded.state.task).toBe("named session");
  expect(loaded.state.startedAt).toBeGreaterThan(0);
});

test("renameSession throws on unreadable run.json and leaves the bytes unchanged", async () => {
  const sessionId = generateSessionId();
  await initSessionDir(cwd, sessionId, home);
  const path = join(sessionDir(cwd, sessionId, home), "run.json");
  const corrupt = "{ not json";
  await writeFile(path, corrupt);

  let thrown: unknown;
  try {
    await renameSession(cwd, sessionId, "should not land", home);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown instanceof Error ? thrown.message : "").toBe("Session state is unreadable");
  expect(await readFile(path, "utf8")).toBe(corrupt);
});
