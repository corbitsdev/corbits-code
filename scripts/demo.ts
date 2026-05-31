#!/usr/bin/env bun

import { resolve } from "node:path";
import { runAgent } from "../src/run-agent.js";
import { runTUI } from "../src/tui/runner.js";

const DEMO_TASK =
  "Add JWT authentication middleware to the product and order routes. Unauthenticated requests should receive a 401 response. Authenticated requests carry a Bearer token in the Authorization header; the middleware should verify the token using a shared secret (HMAC-SHA256). The secret is the string 'demo-secret'. Add tests that cover both authenticated and unauthenticated paths.";
const DEMO_FIXTURE = resolve(import.meta.dirname, "../tests/fixtures/demo-comparison");

async function runCLIMode(): Promise<void> {
  console.log("=== CLI Mode ===");
  await runAgent({
    apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? "",
    baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL ?? "",
    model: process.env.OPENAI_COMPATIBLE_MODEL ?? "",
    providerName: process.env.OPENAI_COMPATIBLE_PROVIDER_NAME ?? "",
    cwd: DEMO_FIXTURE,
    maxTurns: 10,
    task: DEMO_TASK,
    force: true,
    headless: true,
  });
}

async function runTUIMode(): Promise<void> {
  console.log("\n=== TUI Mode ===");
  await runTUI({
    apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? "",
    baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL ?? "",
    model: process.env.OPENAI_COMPATIBLE_MODEL ?? "",
    providerName: process.env.OPENAI_COMPATIBLE_PROVIDER_NAME ?? "",
    cwd: DEMO_FIXTURE,
    maxTurns: 10,
    task: DEMO_TASK,
    force: true,
    headless: false,
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "both";

  if (mode === "cli" || mode === "both") {
    await runCLIMode();
  }

  if (mode === "tui" || mode === "both") {
    await runTUIMode();
  }
}

void main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
