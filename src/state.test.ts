import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveState, loadState, type RunState } from "./session/state.js";
import { sessionDir } from "./session/index.js";

const SESSION_ID = "test-session-001";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

const baseRunState: RunState = {
  status: "running",
  turnsUsed: 3,
  task: "Fix the login bug",
  startedAt: 1_700_000_000_000,
};

describe("state persistence", () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await makeTempDir("state-test-cwd-");
    home = await makeTempDir("state-test-home-");
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  const dir = () => sessionDir(cwd, SESSION_ID, home);

  // ---------------------------------------------------------------------------
  // 1. Round-trip: save then load returns an equal object
  // ---------------------------------------------------------------------------

  test("saveState then loadState returns an equal RunState", async () => {
    await saveState(cwd, SESSION_ID, baseRunState, home);
    const loaded = await loadState(cwd, SESSION_ID, home);
    expect(loaded).toEqual({ kind: "ok", state: baseRunState });
  });

  test("loadState returns a failed run that recorded an error string", async () => {
    const state: RunState = {
      ...baseRunState,
      status: "failed",
      finishedAt: 1_700_000_005_000,
      error: "Cycle commit failed\nhook dump: pre-commit rejected",
    };
    await saveState(cwd, SESSION_ID, state, home);
    const loaded = await loadState(cwd, SESSION_ID, home);
    expect(loaded).toEqual({ kind: "ok", state });
  });

  test("loadState returns a crashed run that recorded an error string", async () => {
    const state: RunState = {
      ...baseRunState,
      status: "crashed",
      finishedAt: 1_700_000_005_000,
      error: "uncaughtException: boom",
    };
    await saveState(cwd, SESSION_ID, state, home);
    const loaded = await loadState(cwd, SESSION_ID, home);
    expect(loaded).toEqual({ kind: "ok", state });
  });

  test("failed and crashed runs with error do not print diagnostics to stderr", async () => {
    const failed: RunState = {
      ...baseRunState,
      status: "failed",
      finishedAt: 1_700_000_005_000,
      error: "Cycle commit failed\nhook dump: pre-commit rejected",
    };
    await saveState(cwd, SESSION_ID, failed, home);
    const crashedId = "test-session-crashed";
    await saveState(
      cwd,
      crashedId,
      {
        ...baseRunState,
        status: "crashed",
        finishedAt: 1_700_000_005_000,
        error: "uncaughtException: boom",
      },
      home,
    );

    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return orig(chunk, ...(rest as []));
    }) as typeof process.stderr.write;
    try {
      expect(await loadState(cwd, SESSION_ID, home)).toEqual({ kind: "ok", state: failed });
      expect((await loadState(cwd, crashedId, home)).kind).toBe("ok");
    } finally {
      process.stderr.write = orig;
    }
    const text = chunks.join("");
    expect(text).not.toContain("ignoring unreadable");
    expect(text).not.toContain(home);
    expect(text).not.toContain("invalid shape");
  });

  test("saveState round-trips optional fields", async () => {
    const state: RunState = {
      ...baseRunState,
      status: "done",
      finishedAt: 1_700_000_005_000,
    };
    await saveState(cwd, SESSION_ID, state, home);
    const loaded = await loadState(cwd, SESSION_ID, home);
    expect(loaded).toEqual({ kind: "ok", state });
  });

  // ---------------------------------------------------------------------------
  // 2. Missing file returns missing (ENOENT mapped, no throw)
  // ---------------------------------------------------------------------------

  test("loadState on missing file returns missing", async () => {
    const result = await loadState(cwd, "nonexistent-session", home);
    expect(result).toEqual({ kind: "missing" });
  });

  // ---------------------------------------------------------------------------
  // 3. Corrupt / truncated JSON returns unreadable rather than throwing
  // ---------------------------------------------------------------------------

  test("loadState with truncated JSON returns unreadable instead of throwing", async () => {
    const stateDir = dir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "run.json"), '{ "turnsUsed": ');

    const result = await loadState(cwd, SESSION_ID, home);
    expect(result).toEqual({ kind: "unreadable" });
  });

  test("loadState does not print unreadable-state diagnostics to stderr", async () => {
    const stateDir = dir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "run.json"), '{ "turnsUsed": ');

    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return orig(chunk, ...(rest as []));
    }) as typeof process.stderr.write;
    try {
      expect(await loadState(cwd, SESSION_ID, home)).toEqual({ kind: "unreadable" });
    } finally {
      process.stderr.write = orig;
    }
    const text = chunks.join("");
    expect(text).not.toContain("ignoring unreadable");
    expect(text).not.toContain(home);
    expect(text).not.toContain("invalid shape");
  });

  // ---------------------------------------------------------------------------
  // 4. Valid JSON but wrong shape returns unreadable via the validators
  // ---------------------------------------------------------------------------

  test("loadState with turnsUsed as string returns unreadable", async () => {
    const stateDir = dir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "run.json"),
      JSON.stringify({ status: "running", turnsUsed: "not-a-number", task: "x", startedAt: 0 }),
    );

    const result = await loadState(cwd, SESSION_ID, home);
    expect(result).toEqual({ kind: "unreadable" });
  });

  // ---------------------------------------------------------------------------
  // 5. Atomic write: saveState uses temp+rename
  // ---------------------------------------------------------------------------

  test("saveState leaves no .tmp file after successful write", async () => {
    await saveState(cwd, SESSION_ID, baseRunState, home);
    const stateDir = dir();
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(stateDir);
    const temps = files.filter((f) => f.includes(".tmp"));
    expect(temps).toHaveLength(0);
  });

  test("saveState overwrites a pre-existing file with well-formed JSON", async () => {
    await saveState(cwd, SESSION_ID, baseRunState, home);
    const updated: RunState = { ...baseRunState, turnsUsed: 99, status: "done" };
    await saveState(cwd, SESSION_ID, updated, home);
    const raw = await readFile(join(dir(), "run.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toEqual(updated);
  });

  test("saveState produces a valid final file that round-trips", async () => {
    await saveState(cwd, SESSION_ID, baseRunState, home);
    const raw = await readFile(join(dir(), "run.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toEqual(baseRunState);
  });

  // ---------------------------------------------------------------------------
  // 6. Identity fields: model and mcpServers round-trip and validate
  // ---------------------------------------------------------------------------

  test("saveState round-trips model and mcpServers", async () => {
    const state: RunState = {
      ...baseRunState,
      model: "openai:gpt-5",
      mcpServers: [
        { name: "linear", toolCount: 12 },
        { name: "railway", toolCount: 4 },
      ],
    };
    await saveState(cwd, SESSION_ID, state, home);
    const loaded = await loadState(cwd, SESSION_ID, home);
    expect(loaded).toEqual({ kind: "ok", state });
  });

  test("loadState accepts a record with no model or mcpServers (pre-existing sessions)", async () => {
    await saveState(cwd, SESSION_ID, baseRunState, home);
    const loaded = await loadState(cwd, SESSION_ID, home);
    expect(loaded).toEqual({ kind: "ok", state: baseRunState });
  });

  test("loadState rejects a mcpServers entry missing toolCount", async () => {
    const stateDir = dir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "run.json"),
      JSON.stringify({
        status: "running",
        turnsUsed: 0,
        task: "x",
        startedAt: 0,
        mcpServers: [{ name: "linear" }],
      }),
    );

    const result = await loadState(cwd, SESSION_ID, home);
    expect(result).toEqual({ kind: "unreadable" });
  });
});
