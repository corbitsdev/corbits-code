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

async function waitForRunningRunJson(): Promise<void> {
  for (;;) {
    if (existsSync(runJsonPath)) {
      try {
        const state = JSON.parse(readFileSync(runJsonPath, "utf8")) as { status?: string };
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
    installSignalHandlers();
    const config = {
      command: "exec",
      task,
      cwd,
      configured: true,
      providerName: "test-provider",
      model: "test-model",
      providers: {},
      force: false,
      dangerouslySkipPermissions: true,
      autoMode: false,
      sessionId,
    } as unknown as Config;
    void runExec(config);
    await waitForRunningRunJson();
    process.stdout.write(`${runDir}\n`);
    await new Promise<never>(() => undefined);
  },
);
