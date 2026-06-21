#!/usr/bin/env bun

import { loadConfig } from "./config/index.js";
import { loadState, loadDirectorState } from "./session/state.js";
import { runAgent } from "./agent/run-agent.js";
import { runTUI } from "./tui/runner.js";
import { runOnboarding } from "./tui/onboarding.js";
import type { Config, UnconfiguredConfig } from "./config/index.js";
import { resolveLatestSession } from "./session/index.js";

export type MainRunners = {
  runAgent(
    config: Config,
    initialStartedAt?: number,
    initialDirectorState?: NonNullable<Awaited<ReturnType<typeof loadDirectorState>>>,
  ): Promise<number>;
  runTUI(config: Config): Promise<number>;
  runOnboarding(config: UnconfiguredConfig): Promise<number>;
};

/* eslint-disable no-console */

function printHelp(): void {
  console.log("Usage: intercode [run] <task description>");
  console.log("       intercode resume [--headless] [--force]");
  console.log("");
  console.log("Options:");
  console.log("  --headless, -h     Run in headless CLI mode (default: TUI)");
  console.log("  --cwd <dir>        Working directory (default: current directory)");
  console.log("  --config <path>    Settings file to use (default: ~/.intercode/settings.json)");
  console.log("  --provider <name>  Select a configured provider");
  console.log("  --model <id>       Select a model for the active provider");
  console.log("  --force            Override an existing run state");
  console.log("                     For resume: also allows picking a completed session in the TUI");
  console.log("  --auto             Auto-approve safe shell and file writes/edits (default; recoverable via git)");
  console.log("  --no-auto          Disable auto mode: ask before every file write/edit and command");
  console.log("  --help             Show this help message");
  console.log("");
  console.log("Configuration:");
  console.log("  Providers and credentials are read from ~/.intercode/settings.json");
  console.log("  (selection can be overridden per repo via .intercode/settings.json).");
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
    const config = await loadConfig(args, { allowUnconfigured: true });
    if (config.configured === false) {
      if (config.headless) {
        console.error(`intercode: ${config.providerError}`);
        return 1;
      }
      return runners.runOnboarding(config);
    }
    if (!config.headless) {
      return runners.runTUI({ ...config, resumePicker: true });
    }
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
      console.error(`intercode: ${config.providerError}`);
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

function writeCrashLog(kind: string, err: unknown): void {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const cwd = process.cwd();
    const projectSlug = cwd.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
    const errorsDir = `${os.homedir()}/.intercode/projects/${projectSlug}/errors`;
    fs.mkdirSync(errorsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = `${errorsDir}/${stamp}.txt`;
    const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
    fs.writeFileSync(file, `${kind}\n${new Date().toISOString()}\ncwd: ${cwd}\n\n${stack}\n`);
  } catch {
    // best-effort — don't let the crash logger itself throw
  }
}

if (import.meta.main) {
  process.on("uncaughtException", (err: Error) => {
    writeCrashLog("uncaughtException", err);
    // eslint-disable-next-line no-console
    console.error(`intercode: uncaught exception: ${err.message}`);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    writeCrashLog("unhandledRejection", reason);
    // eslint-disable-next-line no-console
    console.error(`intercode: unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
    process.exit(1);
  });

  void main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      writeCrashLog("mainRejection", err);
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`intercode: ${message}`);
      process.exit(1);
    },
  );
}
/* eslint-enable no-console */
