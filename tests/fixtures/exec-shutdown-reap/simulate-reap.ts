// Spawned by tests/integration/exec-shutdown-reap.test.ts. Starts a tagged
// sleep through the real shell-guard plugin, registers exec dispose as the
// process dispose host, then takes the requested exit path so the parent can
// assert the child was reaped.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { disposeExecRuntime } from "../../../src/exec/runner.js";
import { shellGuardPlugin } from "../../../src/plugins/shell-guard-plugin.js";
import { setActiveDisposeHost } from "../../../src/session/active-host.js";

const token = process.env["REAP_TOKEN"];
const path = process.env["REAP_PATH"];
const countPath = process.env["REAP_COUNT_PATH"];
if (token === undefined || path === undefined || countPath === undefined) {
  throw new Error("REAP_TOKEN, REAP_PATH, and REAP_COUNT_PATH must be set");
}

const reapToken = token;
const exitPath = path;
const disposeCountPath = countPath;

// Handlers must be installed before READY. Importing src/index.js is slow, and
// the parent sends the signal as soon as it sees READY.
if (exitPath === "crash") {
  const { installCrashHandlers } = await import("../../../src/index.js");
  installCrashHandlers();
} else if (exitPath === "signal") {
  const { installSignalHandlers } = await import("../../../src/index.js");
  installSignalHandlers();
}

const fallback = async (call: ToolCall): Promise<ToolResult> => ({
  callId: call.id,
  content: "FALLBACK",
});

const plugin = shellGuardPlugin(process.cwd());
if (plugin.middleware === undefined || plugin.dispose === undefined) {
  throw new Error("shell-guard plugin missing middleware or dispose");
}

let disposeCalls = 0;
const pluginDispose = plugin.dispose.bind(plugin);
const countedDispose = async (): Promise<void> => {
  disposeCalls += 1;
  writeFileSync(disposeCountPath, String(disposeCalls));
  await pluginDispose();
};

const toolset = { dispose: countedDispose };
const host = (): Promise<void> =>
  disposeExecRuntime({
    agent: null,
    toolset,
    subAgentSessions: null,
  });

const handler = plugin.middleware(fallback);
const cmd = `bash -c 'IC_GUARD_TAG=${reapToken} sleep 600 & IC_GUARD_TAG=${reapToken} exec sleep 600'`;
void handler(
  { id: "reap-live", name: "run_shell", arguments: { command: cmd } },
  new AbortController().signal,
);

async function waitForTag(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    const probe = spawnSync("pgrep", ["-f", reapToken], { encoding: "utf8" });
    if ((probe.stdout?.trim() ?? "").length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`tagged child did not appear: ${reapToken}`);
}

await waitForTag();
setActiveDisposeHost(host);
writeFileSync(disposeCountPath, "0");
process.stdout.write("READY\n");

if (exitPath === "quit") {
  await host();
  await host();
  writeFileSync(disposeCountPath, String(disposeCalls));
  process.exit(0);
}

if (exitPath === "crash") {
  setImmediate(() => {
    throw new Error("simulated reap crash");
  });
  await new Promise<never>(() => undefined);
}

if (exitPath === "signal") {
  await new Promise<never>(() => undefined);
}

throw new Error(`unknown REAP_PATH: ${exitPath}`);
