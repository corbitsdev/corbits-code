#!/usr/bin/env bun

import { resolve } from "node:path";
import { runAgent } from "../src/run-agent.js";
import { runTUI } from "../src/tui/runner.js";

const DEMO_TASK = "Add a hello world endpoint to the API";
const DEMO_FIXTURE = resolve(import.meta.dirname, "../tests/fixtures/multi-file-service");

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
    tui: false,
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
    tui: true,
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
