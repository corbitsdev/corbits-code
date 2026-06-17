import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveState,
  loadState,
  saveDirectorState,
  loadDirectorState,
  type RunState,
  type DirectorPersistedState,
} from "./session/state.js";

const SESSION_ID = "test-session-001";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "state-test-"));
}

const baseRunState: RunState = {
  status: "running",
  turnsUsed: 3,
  task: "Fix the login bug",
  startedAt: 1_700_000_000_000,
};

const baseDirectorState: DirectorPersistedState = {
  turnsUsed: 3,
  submitCalled: false,
  callIdToName: { "call-1": "readFile", "call-2": "writeFile" },
  idleCycles: 0,
  tasks: [{ id: "t1", title: "Fix login bug", status: "doing" as const }],
  filesRead: [{ path: "src/login.ts", turn: 1 }],
};

describe("state persistence", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTempDir();
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // 1. Round-trip: save then load returns an equal object
  // ---------------------------------------------------------------------------

  test("saveState then loadState returns an equal RunState", async () => {
    await saveState(cwd, SESSION_ID, baseRunState);
    const loaded = await loadState(cwd, SESSION_ID);
    expect(loaded).toEqual(baseRunState);
  });

  test("saveState round-trips optional fields", async () => {
    const state: RunState = {
      ...baseRunState,
      status: "done",
      finishedAt: 1_700_000_005_000,
    };
    await saveState(cwd, SESSION_ID, state);
    const loaded = await loadState(cwd, SESSION_ID);
    expect(loaded).toEqual(state);
  });

  test("saveDirectorState then loadDirectorState returns an equal DirectorPersistedState", async () => {
    await saveDirectorState(cwd, SESSION_ID, baseDirectorState);
    const loaded = await loadDirectorState(cwd, SESSION_ID);
    expect(loaded).toEqual(baseDirectorState);
  });

  // ---------------------------------------------------------------------------
  // 2. Missing file returns null (ENOENT mapped, no throw)
  // ---------------------------------------------------------------------------

  test("loadState on missing file returns null", async () => {
    const result = await loadState(cwd, "nonexistent-session");
    expect(result).toBeNull();
  });

  test("loadDirectorState on missing file returns null", async () => {
    const result = await loadDirectorState(cwd, "nonexistent-session");
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 3. Corrupt / truncated JSON returns null rather than throwing
  //    BUG: JSON.parse throws SyntaxError (no .code property), so the catch
  //    block re-throws it. The fix is to catch SyntaxError and return null.
  // ---------------------------------------------------------------------------

  test("loadState with truncated JSON returns null instead of throwing", async () => {
    const stateDir = join(cwd, ".agent-state", SESSION_ID);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "run.json"), '{ "turnsUsed": ');

    const result = await loadState(cwd, SESSION_ID);
    expect(result).toBeNull();
  });

  test("loadDirectorState with truncated JSON returns null instead of throwing", async () => {
    const stateDir = join(cwd, ".agent-state", SESSION_ID);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "director.json"), '{ "turnsUsed": ');

    const result = await loadDirectorState(cwd, SESSION_ID);
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 4. Valid JSON but wrong shape returns null via the validators
  // ---------------------------------------------------------------------------

  test("loadState with turnsUsed as string returns null", async () => {
    const stateDir = join(cwd, ".agent-state", SESSION_ID);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "run.json"),
      JSON.stringify({ status: "running", turnsUsed: "not-a-number", task: "x", startedAt: 0 }),
    );

    const result = await loadState(cwd, SESSION_ID);
    expect(result).toBeNull();
  });

  test("loadDirectorState with turnsUsed as string returns null", async () => {
    const stateDir = join(cwd, ".agent-state", SESSION_ID);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "director.json"),
      JSON.stringify({
        turnsUsed: "not-a-number",
        submitCalled: false,
        callIdToName: {},
        idleCycles: 0,
        planSubmitted: false,
        plan: [],
      }),
    );

    const result = await loadDirectorState(cwd, SESSION_ID);
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 5. Atomic write: saveState uses temp+rename
  //    BUG: saveState called writeFile directly to the final path, so a process
  //    killed mid-write would leave torn JSON. Fixed: write to a .tmp file then
  //    rename into place, matching the approvals-store pattern.
  //
  //    Direct interception of the bound `rename` import is not possible from the
  //    test. Instead, we verify observable post-conditions: the canonical path
  //    contains well-formed JSON after the call, no temp file remains, and a
  //    pre-existing file at the canonical path is fully replaced (not torn).
  // ---------------------------------------------------------------------------

  test("saveState leaves no .tmp file after successful write", async () => {
    await saveState(cwd, SESSION_ID, baseRunState);
    const stateDir = join(cwd, ".agent-state", SESSION_ID);
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(stateDir);
    const temps = files.filter((f) => f.includes(".tmp"));
    expect(temps).toHaveLength(0);
  });

  test("saveDirectorState leaves no .tmp file after successful write", async () => {
    await saveDirectorState(cwd, SESSION_ID, baseDirectorState);
    const stateDir = join(cwd, ".agent-state", SESSION_ID);
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(stateDir);
    const temps = files.filter((f) => f.includes(".tmp"));
    expect(temps).toHaveLength(0);
  });

  test("saveState overwrites a pre-existing file with well-formed JSON", async () => {
    // Write a known good file, then overwrite — simulates repeated saves.
    await saveState(cwd, SESSION_ID, baseRunState);
    const updated: RunState = { ...baseRunState, turnsUsed: 99, status: "done" };
    await saveState(cwd, SESSION_ID, updated);
    const raw = await readFile(join(cwd, ".agent-state", SESSION_ID, "run.json"), "utf8");
    // The canonical path must contain only the new payload, never a partial mix.
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toEqual(updated);
  });

  test("saveState produces a valid final file that round-trips", async () => {
    // Rename completed — file is well-formed JSON at the canonical path.
    await saveState(cwd, SESSION_ID, baseRunState);
    const raw = await readFile(join(cwd, ".agent-state", SESSION_ID, "run.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toEqual(baseRunState);
  });

  // ---------------------------------------------------------------------------
  // 6. Director state reconstruction: missing newer fields apply defaults
  // ---------------------------------------------------------------------------

  test("loadDirectorState with missing filesRead field still returns valid state", async () => {
    const stateDir = join(cwd, ".agent-state", SESSION_ID);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });

    // Write a state object that omits the optional filesRead field.
    const minimal = {
      turnsUsed: 1,
      submitCalled: false,
      callIdToName: {},
      idleCycles: 0,
      tasks: [],
    };
    await writeFile(join(stateDir, "director.json"), JSON.stringify(minimal));

    const loaded = await loadDirectorState(cwd, SESSION_ID);
    // filesRead is optional in the type — the validator accepts its absence.
    expect(loaded).not.toBeNull();
    expect(loaded!.turnsUsed).toBe(1);
    expect(loaded!.filesRead).toBeUndefined();
  });
});
