// Test preload: normalize the ambient environment before any test file loads.
// Tests that read state they never set pass on a dev machine and fail on a
// runner; clearing the variables here surfaces that coupling locally — a test
// that needs COLORTERM must set COLORTERM. HOME is deliberately left alone:
// Bun snapshots os.homedir() at start, so a preload cannot redirect it; tests
// resolving home-level state take the explicit `home` / `--config` overrides.

import { spawnSync } from "node:child_process";

// Terminal capability probes: a developer terminal sets these, a runner does not.
const AMBIENT_TERMINAL_VARS = [
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
];

// Eval harness plumbing that leaks between files when a test forgets to restore it.
const AMBIENT_HARNESS_VARS = ["EVAL_HTTP_URL"];

for (const key of [...AMBIENT_TERMINAL_VARS, ...AMBIENT_HARNESS_VARS]) {
  Reflect.deleteProperty(process.env, key);
}

for (const key of Object.keys(process.env)) {
  if (key.startsWith("CORBITS_")) Reflect.deleteProperty(process.env, key);
}

// No test may export telemetry or write an installationId into a real global settings file.
process.env.CORBITS_TELEMETRY = "0";
process.env.DO_NOT_TRACK = "1";

// An absent dependency must be loud: without rg, the grep/search tools fall
// back to the TypeScript walker and the rg path goes untested.
const rg = spawnSync("rg", ["--version"], { stdio: "ignore" });
if (rg.error !== undefined || rg.status !== 0) {
  throw new Error(
    "ripgrep (rg) is required to run the test suite: the grep/search tools have " +
      "a ripgrep path and a fallback path, and without rg only the fallback is " +
      "exercised. Install it (brew install ripgrep / apt-get install ripgrep).",
  );
}
