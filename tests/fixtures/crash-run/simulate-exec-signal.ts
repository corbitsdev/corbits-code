// Spawned as a subprocess by tests/integration/exec-signal-finalize.test.ts.
// Installs process-level signal handlers the way import.meta.main does, then
// calls production runExec. Does not register the active-run handle itself —
// that is the product path under test.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "../../../src/config/index.js";
import { sessionDir } from "../../../src/session/index.js";
import { withMockedModuleDuring } from "../../helpers/mock-module.js";

const cwd = process.cwd();
const sessionId = process.env["SIGNAL_TEST_SESSION_ID"];
if (sessionId === undefined) {
  throw new Error("SIGNAL_TEST_SESSION_ID must be set");
}

const task = "headless exec signal task";
const runDir = sessionDir(cwd, sessionId);
const runJsonPath = join(runDir, "run.json");
const turnsUsed = Number(process.env["SIGNAL_TEST_TURNS_USED"] ?? "5");

async function waitForRunningRunJson(): Promise<void> {
  for (;;) {
    if (existsSync(runJsonPath)) {
      try {
        const state = JSON.parse(readFileSync(runJsonPath, "utf8")) as {
          status?: string;
        };
        if (state.status === "running") return;
      } catch {
        // rename/parse race on the first persist
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

await withMockedModuleDuring(
  import.meta.resolve("../../../src/session/assemble-runtime.js"),
  (real: typeof import("../../../src/session/assemble-runtime.js")) => ({
    ...real,
    // Stall the first await after persist("running") so bootstrap catch cannot
    // persist("failed") before the parent sends a signal.
    assembleInferenceBase: () => new Promise<never>(() => undefined),
  }),
  async () => {
    const { installSignalHandlers } = await import("../../../src/index.js");
    const { runExec } = await import("../../../src/exec/runner.js");
    const { getActiveRun, syncRunStateHandle } =
      await import("../../../src/session/active-run.js");
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
    await waitForRunningRunJson();
    const handle = getActiveRun();
    if (handle === null) {
      throw new Error("runExec did not register an active-run handle");
    }
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
