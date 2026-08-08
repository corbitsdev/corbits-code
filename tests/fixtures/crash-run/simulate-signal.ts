// Spawned as a subprocess by tests/integration/signal-finalize.test.ts.
// Mimics what runTUI does at startup (register the active run, write the
// initial "running" run.json) and what index.ts does at process entry
// (install the signal handlers), then waits to receive a real signal sent by
// the test from outside the process.
import { installSignalHandlers } from "../../../src/index.js";
import { setActiveRun } from "../../../src/session/active-run.js";
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

setActiveRun({ sessionId, cwd, active: true, task, startedAt, model });
installSignalHandlers();

process.stdout.write(`${sessionDir(cwd, sessionId)}\n`);
process.stdout.write("ready\n");

// Keep the event loop alive until the test sends a signal.
setInterval(() => {}, 60_000);
