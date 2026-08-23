// Test preload: normalize the ambient environment before any test file loads.
//
// Tests that read state they never set pass on a developer machine and fail on
// a runner. Clearing the variables here makes that coupling fail immediately and
// locally instead: a test that needs COLORTERM must set COLORTERM.
//
// The home directory deliberately is not sandboxed here. Bun snapshots
// os.homedir() at process start, so assigning HOME from a preload has no effect
// on the code under test; a test that resolves home-level state must take the
// explicit `home` / `--config` override the production API already exposes.

import { spawnSync } from "node:child_process";

// Terminal capability probes: a developer terminal sets these, a runner does not.
const AMBIENT_TERMINAL_VARS = ["COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"];

// Eval harness plumbing that leaks between files when a test forgets to restore it.
const AMBIENT_HARNESS_VARS = ["EVAL_HTTP_URL"];

for (const key of [...AMBIENT_TERMINAL_VARS, ...AMBIENT_HARNESS_VARS]) {
  delete process.env[key];
}

for (const key of Object.keys(process.env)) {
  if (key.startsWith("CORBITS_")) delete process.env[key];
}

// No test may export telemetry or write an installationId into a real global
// settings file, regardless of which code path a test happens to reach.
process.env.CORBITS_TELEMETRY = "0";
process.env.DO_NOT_TRACK = "1";

// An absent dependency must be loud. Without ripgrep the grep and search tools
// silently fall back to the TypeScript walker and the suite passes while the
// ripgrep path goes untested — exactly how a broken CI run stayed green.
const rg = spawnSync("rg", ["--version"], { stdio: "ignore" });
if (rg.error !== undefined || rg.status !== 0) {
  throw new Error(
    "ripgrep (rg) is required to run the test suite: the grep/search tools have " +
      "a ripgrep path and a fallback path, and without rg only the fallback is " +
      "exercised. Install it (brew install ripgrep / apt-get install ripgrep).",
  );
}
