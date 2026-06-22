#!/usr/bin/env bun

import { resolve } from "node:path";
import { loadConfig } from "../src/config/index.js";
import { runTUI } from "../src/tui/runner.js";

const DEMO_TASK =
  "Add JWT authentication middleware to the product and order routes. Unauthenticated requests should receive a 401 response. Authenticated requests carry a Bearer token in the Authorization header; the middleware should verify the token using a shared secret (HMAC-SHA256). The secret is the string 'demo-secret'. Add tests that cover both authenticated and unauthenticated paths.";
const DEMO_FIXTURE = resolve(import.meta.dirname, "../tests/fixtures/demo-comparison");

async function runTUIMode(): Promise<void> {
  console.log("=== TUI demo (fixture repo) ===");
  const config = await loadConfig(
    ["--cwd", DEMO_FIXTURE, "--force", DEMO_TASK],
    { allowUnconfigured: false },
  );
  if (!config.configured) {
    throw new Error(config.providerError);
  }
  const code = await runTUI({ ...config, task: DEMO_TASK, maxTurns: 10 });
  process.exitCode = code;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "tui";
  if (mode === "cli") {
    console.error(
      "Headless CLI demo was removed with run-agent; use mode=tui or run intercode from the fixture with env vars set.",
    );
    process.exit(1);
  }
  if (mode === "tui" || mode === "both") {
    await runTUIMode();
    return;
  }
  console.error(`Unknown mode "${mode}". Use: tui`);
  process.exit(1);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});