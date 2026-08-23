// Spawned as a subprocess by tests/integration/signal-finalize.test.ts.
// Mimics what runTUI does at startup (register the active run, write the
// initial "running" run.json) and what index.ts does at process entry
// (install the signal handlers), then waits to receive a real signal sent by
// the test from outside the process.
//
// Also parks two unawaited straggler snapshot writes behind setTestWriteGate,
// released only after the signal handler has flipped isCrashed via
// markCrashed(). Without that fence, a chained "running" rename can clobber
// the signal's terminal "failed" write — the same race the crash path already
// fences.
import { installSignalHandlers } from "../../../src/index.js";
import { isCrashed, setActiveRun, setTestWriteGate } from "../../../src/session/active-run.js";
import { sessionDir } from "../../../src/session/index.js";
import { saveState } from "../../../src/session/state.js";

const cwd = process.cwd();
const sessionId = process.env["SIGNAL_TEST_SESSION_ID"];
if (sessionId === undefined) {
  throw new Error("SIGNAL_TEST_SESSION_ID must be set");
}

const startedAt = Date.now();
const task = "simulated signal task";
const model = "test-provider:test-model";

await saveState(cwd, sessionId, {
  status: "running",
  turnsUsed: 3,
  task,
  startedAt,
  model,
});

setActiveRun({ sessionId, cwd, task, startedAt, model });
installSignalHandlers();

let releaseGate: () => void;
const gate = new Promise<void>((resolve) => {
  releaseGate = resolve;
});
setTestWriteGate(gate);
void saveState(cwd, sessionId, { status: "running", turnsUsed: 1, task, startedAt, model });
void saveState(cwd, sessionId, { status: "running", turnsUsed: 2, task, startedAt, model });

process.stdout.write(`${sessionDir(cwd, sessionId)}\n`);
process.stdout.write("ready\n");

// After the parent sends a real signal, installSignalHandlers flips
// isCrashed() before saveCrashState. Releasing the gate then lets the two
// parked writes observe the flag rather than racing the terminal rename.
const poll = setInterval(() => {
  if (isCrashed()) {
    clearInterval(poll);
    releaseGate();
  }
}, 10);
if (typeof poll.unref === "function") poll.unref();

// Keep the event loop alive until the test sends a signal.
setInterval(() => {}, 60_000);
