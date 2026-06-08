#!/usr/bin/env bun

import { resolve } from "node:path";

import { loadConfig } from "./config.js";
import { loadState, loadDirectorState } from "./state.js";
import { runAgent } from "./run-agent.js";
import { runTUI } from "./tui/runner.js";
import { runOnboarding } from "./tui/onboarding.js";
import type { Config, UnconfiguredConfig } from "./config.js";
import { resolveLatestSession } from "./session.js";

export type MainRunners = {
  runAgent(
    config: Config,
    initialStartedAt?: number,
    initialDirectorState?: NonNullable<Awaited<ReturnType<typeof loadDirectorState>>>,
  ): Promise<number>;
  runTUI(config: Config): Promise<number>;
  runOnboarding(config: UnconfiguredConfig): Promise<number>;
};

async function loadEnvFile(path: string): Promise<void> {
  try {
    const file = Bun.file(path);
    const text = await file.text();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || trimmed.length === 0) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      const unquoted = value.replace(/^["']|["']$/g, "");
      if (process.env[key] === undefined) {
        process.env[key] = unquoted;
      }
    }
  } catch {
    // File missing or unreadable — ignore
  }
}

/* eslint-disable no-console */

function printHelp(): void {
  console.log("Usage: interchange-code [run] <task description>");
  console.log("       interchange-code resume [--force]");
  console.log("");
  console.log("Options:");
  console.log("  --headless, -h     Run in headless CLI mode (default: TUI)");
  console.log("  --cwd <dir>        Working directory (default: current directory)");
  console.log("  --config <path>    Settings file to use (default: ~/.interchange/settings.json)");
  console.log("  --provider <name>  Select a configured provider");
  console.log("  --model <id>       Select a model for the active provider");
  console.log("  --force            Override an existing run state");
  console.log("  --auto             Auto-approve non-destructive permissions (safe shell commands, repeat writes)");
  console.log("  --help             Show this help message");
  console.log("");
  console.log("Configuration:");
  console.log("  Providers and credentials are read from ~/.interchange/settings.json");
  console.log("  (selection can be overridden per repo via .interchange/settings.json).");
  console.log("  The OPENAI_COMPATIBLE_* env vars still override individual fields.");
}

export async function mainWithRunners(
  argv: readonly string[],
  runners: MainRunners,
): Promise<number> {
  const args = [...argv];

  if (args.includes("--help")) {
    printHelp();
    return 0;
  }

  if (args[0] === "resume") {
    args.shift();
    const config = await loadConfig(args);
    const session = await resolveLatestSession(config.cwd);
    if (session === null) {
      console.error("No previous run found in this directory.");
      return 1;
    }
    const previous = await loadState(config.cwd, session.sessionId);
    if (previous === null) {
      console.error("No previous run found in this directory.");
      return 1;
    }
    if (previous.status === "done") {
      console.error("Previous run already completed.");
      return 1;
    }
    if (previous.status === "running" && !config.force) {
      console.error("A run is already in progress in this directory. Use --force to override.");
      return 1;
    }
    const directorState = await loadDirectorState(config.cwd, session.sessionId);
    return runners.runAgent(
      { ...config, task: previous.task, sessionId: session.sessionId },
      previous.startedAt,
      directorState ?? undefined,
    );
  }

  // Strip optional "run" verb
  if (args[0] === "run") {
    args.shift();
  }

  const config = await loadConfig(args, { allowUnconfigured: true });

  if (config.configured === false) {
    if (config.headless) {
      console.error(`interchange-code: ${config.providerError}`);
      return 1;
    }
    return runners.runOnboarding(config);
  }

  if (config.headless && config.task.length === 0) {
    console.error("task description is required");
    return 1;
  }
  if (config.headless) {
    return runners.runAgent(config);
  }
  return runners.runTUI(config);
}

export async function main(argv: readonly string[]): Promise<number> {
  return mainWithRunners(argv, { runAgent, runTUI, runOnboarding });
}

const projectRoot = resolve(import.meta.dirname, "..");
if (import.meta.main) {
  await loadEnvFile(resolve(projectRoot, ".env"));

  void main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`interchange-code: ${message}`);
      process.exit(1);
    },
  );
}
/* eslint-enable no-console */
