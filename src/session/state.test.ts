import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Bun mutates the imported namespace object in place when a module is
// mocked, so the capture is shallow-copied immediately -- holding onto the
// live namespace would turn into the mocked exports as soon as mock.module
// below runs, making a later restore a no-op.
const realFs = { ...(await import("node:fs/promises")) };

// Simulates the straggler write's real await point (e.g. cycleRecorder.dispose
// during the terminal path) landing its writeFile after a later-issued
// terminal write's writeFile, so rename-order alone would let it win.
const realWriteFile = realFs.writeFile;
let delayNextWrite = false;
mock.module("node:fs/promises", () => ({
  ...realFs,
  writeFile: async (path: string, data: string) => {
    if (delayNextWrite) {
      delayNextWrite = false;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return realWriteFile(path, data);
  },
}));

afterAll(() => {
  mock.module("node:fs/promises", () => realFs);
});

const { loadState, saveState } = await import("./state.js");
type RunState = Awaited<ReturnType<typeof loadState>>;

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

function state(overrides: Partial<NonNullable<RunState>>): NonNullable<RunState> {
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
  expect(final?.status).toBe("done");
  expect(final?.finishedAt).toBe(999);
});

test("saveState calls for different sessions do not block each other", async () => {
  await Promise.all([
    saveState(cwd, "session-a", state({ task: "a" }), home),
    saveState(cwd, "session-b", state({ task: "b" }), home),
  ]);

  const a = await loadState(cwd, "session-a", home);
  const b = await loadState(cwd, "session-b", home);
  expect(a?.task).toBe("a");
  expect(b?.task).toBe("b");
});
