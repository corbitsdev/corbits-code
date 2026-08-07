// Spawned as a subprocess by tests/integration/crash-finalize.test.ts. Mimics
// what runTUI does at startup (register the active run, write the initial
// "running" run.json) and what index.ts does at process entry (install the
// crash handlers), then throws asynchronously so it surfaces as a genuine
// uncaughtException rather than a synchronous throw the caller could catch.
import { installCrashHandlers } from "../../../src/index.js";
import { setActiveRun } from "../../../src/session/active-run.js";
import { sessionDir } from "../../../src/session/index.js";
import { saveState } from "../../../src/session/state.js";

const cwd = process.cwd();
const sessionId = process.env["CRASH_TEST_SESSION_ID"];
if (sessionId === undefined) {
  throw new Error("CRASH_TEST_SESSION_ID must be set");
}

await saveState(cwd, sessionId, {
  status: "running",
  turnsUsed: 3,
  task: "simulated crash task",
  startedAt: Date.now(),
});

setActiveRun({ sessionId, cwd, active: true });
installCrashHandlers();

process.stdout.write(`${sessionDir(cwd, sessionId)}\n`);

setImmediate(() => {
  throw new Error("simulated crash");
});
