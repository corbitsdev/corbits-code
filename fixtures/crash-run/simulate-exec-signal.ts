// Spawned as a subprocess by e2e/exec-signal-finalize.test.ts.
// Installs process-level signal handlers the way import.meta.main does, then
// calls production runExec. The fixture never registers the active-run handle
// itself, because runExec registering it is the product path under test.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "../../src/config/index.js";
import { sessionDir } from "../../src/session/index.js";
import { withMockedModuleDuring } from "../../testkit/mock-module.js";

const cwd = process.cwd();
const sessionId = process.env["SIGNAL_TEST_SESSION_ID"];
if (sessionId === undefined) {
  throw new Error("SIGNAL_TEST_SESSION_ID must be set");
}

const task = "headless exec signal task";
const runDir = sessionDir(cwd, sessionId);
const runJsonPath = join(runDir, "run.json");
const turnsUsed = Number(process.env["SIGNAL_TEST_TURNS_USED"] ?? "5");

async function pollUntil<T>(
  probe: () => T | null,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(errorMessage);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function runJsonIsRunning(): true | null {
  if (!existsSync(runJsonPath)) return null;
  try {
    const state = JSON.parse(readFileSync(runJsonPath, "utf8")) as {
      status?: string;
    };
    return state.status === "running" ? true : null;
  } catch {
    // The first persist can be read mid-rename; retry on the next poll.
    return null;
  }
}

await withMockedModuleDuring(
  import.meta.resolve("../../src/session/assemble-runtime.js"),
  (real: typeof import("../../src/session/assemble-runtime.js")) => ({
    ...real,
    // Stall the first await after persist("running") so bootstrap catch cannot
    // persist("failed") before the parent sends a signal.
    assembleInferenceBase: () => new Promise<never>(() => undefined),
  }),
  async () => {
    const { installSignalHandlers } =
      await import("../../src/process-handlers.js");
    const { runExec } = await import("../../src/exec/runner.js");
    const { getActiveRun, syncRunStateHandle } =
      await import("../../src/session/active-run.js");
    installSignalHandlers();
    const config = {
      command: "exec",
      task,
      cwd,
      configured: true,
      providerName: "test-provider",
      model: "test-model",
      providers: {},
      dangerouslySkipPermissions: true,
      autoMode: false,
      sessionId,
    } as unknown as Config;
    void runExec(config);
    await pollUntil(
      runJsonIsRunning,
      10_000,
      `run.json at ${runJsonPath} did not reach status "running"`,
    );
    // runExec registers the handle after saveState resolves, so run.json can
    // show "running" on disk before the handle exists.
    const handle = await pollUntil(
      getActiveRun,
      5_000,
      "runExec did not register an active-run handle",
    );
    // Advance the live counter the way a mid-run snapshot would, without
    // reading run.json on the signal path under test.
    syncRunStateHandle(handle, {
      turnsUsed,
      task: handle.task,
      startedAt: handle.startedAt,
      ...(handle.model !== undefined ? { model: handle.model } : {}),
    });
    process.stdout.write(`${runDir}\n`);
    await new Promise<never>(() => undefined);
  },
);
