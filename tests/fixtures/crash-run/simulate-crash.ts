// Spawned as a subprocess by tests/integration/crash-finalize.test.ts. Mimics
// what runTUI does at startup (register the active run, write the initial
// "running" run.json) and what index.ts does at process entry (install the
// crash handlers), then throws asynchronously so it surfaces as a genuine
// uncaughtException rather than a synchronous throw the caller could catch.
import { installCrashHandlers } from "../../../src/index.js";
import { setActiveRun, setTestWriteGate } from "../../../src/session/active-run.js";
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

setActiveRun({ sessionId, cwd, task, startedAt, model });
installCrashHandlers();

process.stdout.write(`${sessionDir(cwd, sessionId)}\n`);

// Hold every write issued from here on at the gate, before it reaches
// isCrashed(). This makes the race deterministic instead of hoping real
// filesystem timing interleaves the right way: the two straggler writes
// below are guaranteed to still be queued, not dispatched to the kernel,
// when the crash handler flips isCrashed() — the exact scenario the guard
// exists for.
let releaseGate: () => void;
const gate = new Promise<void>((resolve) => {
  releaseGate = resolve;
});
setTestWriteGate(gate);

// Two unawaited straggler snapshot writes, chained behind each other in
// state.ts's per-session queue — what persistRunSnapshot fires on every
// turn/model-switch/MCP-connect event. Both are parked at the gate.
void saveState(cwd, sessionId, { status: "running", turnsUsed: 1, task, startedAt, model });
void saveState(cwd, sessionId, { status: "running", turnsUsed: 2, task, startedAt, model });

// Throws inside setImmediate so it surfaces as a real uncaughtException.
// Node/Bun run the exception's own uncaughtException dispatch — including
// handleFatal's synchronous markCrashed() call, which precedes its first
// await — to completion before the event loop reaches the next queued
// setImmediate callback. The second setImmediate below is therefore
// guaranteed to run after isCrashed() has flipped to true, so releasing the
// gate there always lets the two parked writes observe the flag rather than
// racing it.
setImmediate(() => {
  throw new Error("simulated crash");
});
setImmediate(() => {
  releaseGate();
});
