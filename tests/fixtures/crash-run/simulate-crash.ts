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

const startedAt = Date.now();
const task = "simulated crash task";
const model = "test-provider:test-model";

await saveState(cwd, sessionId, {
  status: "running",
  turnsUsed: 3,
  task,
  startedAt,
  model,
});

setActiveRun({ sessionId, cwd, active: true, task, startedAt, model });
installCrashHandlers();

process.stdout.write(`${sessionDir(cwd, sessionId)}\n`);

// Queue a burst of unawaited straggler snapshot writes (what
// persistRunSnapshot does on every turn/model-switch/MCP-connect event) right
// before crashing. Each is chained onto the previous one in state.ts's
// per-session write queue, so most of these are still waiting their turn —
// not yet dispatched to the kernel — at the moment the crash handler flips
// the isCrashed() flag. Without that guard, one of these landing after
// saveCrashState's rename() would resurrect status: "running".
for (let i = 0; i < 50; i++) {
  void saveState(cwd, sessionId, {
    status: "running",
    turnsUsed: i,
    task,
    startedAt,
    model,
  });
}

setImmediate(() => {
  throw new Error("simulated crash");
});
