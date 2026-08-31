import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withMockedModule } from "../../tests/helpers/mock-module.js";

// Simulates the straggler write's real await point (e.g. cycleRecorder.dispose
// during the terminal path) landing its writeFile after a later-issued
// terminal write's writeFile, so rename-order alone would let it win.
let delayNextWrite = false;
await withMockedModule(
  import.meta.resolve("node:fs/promises"),
  (real: typeof import("node:fs/promises")) => ({
    ...real,
    writeFile: async (path: string, data: string) => {
      if (delayNextWrite) {
        delayNextWrite = false;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return real.writeFile(path, data);
    },
  }),
);

const { finalizeRunState, loadState, saveState } = await import("./state.js");
const { getActiveRun, setActiveRun } = await import("./active-run.js");
type RunState = import("./state.js").RunState;

let cwd = "";
let home = "";

beforeEach(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  cwd = join(tmpdir(), `corbits-state-${stamp}`);
  home = join(tmpdir(), `corbits-state-home-${stamp}`);
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

function state(overrides: Partial<RunState>): RunState {
  return {
    status: "running",
    turnsUsed: 0,
    task: "task",
    startedAt: 1,
    ...overrides,
  };
}

test("a straggler snapshot started before a terminal write does not overwrite it", async () => {
  const sessionId = "sess-race";

  delayNextWrite = true;
  const straggler = saveState(cwd, sessionId, state({ status: "running" }), home);
  const terminal = saveState(cwd, sessionId, state({ status: "done", finishedAt: 999 }), home);

  await Promise.all([straggler, terminal]);

  const final = await loadState(cwd, sessionId, home);
  expect(final).toMatchObject({ kind: "ok", state: { status: "done", finishedAt: 999 } });
});

test("a persisted terminal status agrees with the active-run handle without a second call site", async () => {
  const sessionId = "sess-terminal";
  setActiveRun({ sessionId, cwd, task: "task", startedAt: 1 });

  await finalizeRunState(cwd, sessionId, state({ status: "done", finishedAt: 1000 }), home);

  const persisted = await loadState(cwd, sessionId, home);
  expect(persisted).toMatchObject({ kind: "ok", state: { status: "done" } });
  // The only liveness representation left is presence in the active-run
  // slot -- a terminal RunState.status must leave nothing there to read.
  expect(getActiveRun()).toBeNull();
});

test("saveState calls for different sessions do not block each other", async () => {
  await Promise.all([
    saveState(cwd, "session-a", state({ task: "a" }), home),
    saveState(cwd, "session-b", state({ task: "b" }), home),
  ]);

  const a = await loadState(cwd, "session-a", home);
  const b = await loadState(cwd, "session-b", home);
  expect(a).toMatchObject({ kind: "ok", state: { task: "a" } });
  expect(b).toMatchObject({ kind: "ok", state: { task: "b" } });
});
