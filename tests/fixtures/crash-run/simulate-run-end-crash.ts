// Spawned as a subprocess by tests/integration/crash-finalize.test.ts. Mimics
// the run-end write (writeRunSnapshot's "done" call through finalizeRunState
// in state.ts) landing mid-flight when an unrelated uncaughtException fires,
// rather than simulate-crash.ts's scenario of a crash escaping before any
// terminal write is issued at all.
import { installCrashHandlers } from "../../../src/index.js";
import { setActiveRun, setTestWriteGate } from "../../../src/session/active-run.js";
import { sessionDir } from "../../../src/session/index.js";
import { finalizeRunState, saveState } from "../../../src/session/state.js";

const cwd = process.cwd();
const sessionId = process.env["RUN_END_TEST_SESSION_ID"];
if (sessionId === undefined) {
  throw new Error("RUN_END_TEST_SESSION_ID must be set");
}

const startedAt = Date.now();
const task = "simulated run-end task";
const model = "test-provider:test-model";

await saveState(cwd, sessionId, {
  status: "running",
  turnsUsed: 3,
  task,
  startedAt,
  model,
});

setActiveRun({ sessionId, cwd, task, startedAt, model });
installCrashHandlers();

process.stdout.write(`${sessionDir(cwd, sessionId)}\n`);

// Held open for the rest of the process's life — saveCrashState (the crash
// path) bypasses this gate entirely via a raw atomicWrite, so parking the
// run-end write here forever is enough to simulate "the run-end snapshot
// write is still in flight" without needing to release it: whether the
// process observes "done" or "crashed" is decided before this write would
// ever land.
setTestWriteGate(new Promise(() => {}));

// Fire the run-end write the same way writeRunSnapshot does for a terminal
// status, but don't await it — runner.ts doesn't either from the crash
// handler's point of view, since the crash below arrives asynchronously.
void finalizeRunState(cwd, sessionId, {
  status: "done",
  turnsUsed: 3,
  task,
  startedAt,
  finishedAt: Date.now(),
  model,
});

// Runs after the synchronous portion of finalizeRunState above (its
// clearActiveRun call, if placed before the saveState await) has already
// executed, since setImmediate always waits for the current synchronous
// script to finish. This is the window the bug reopened: an unrelated
// exception landing while the run-end write is still in flight.
setImmediate(() => {
  throw new Error("simulated crash during run-end write");
});
