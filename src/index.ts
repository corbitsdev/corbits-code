#!/usr/bin/env bun

import { resolve } from "node:path";

import { loadConfig } from "./config.js";
import { loadState, loadDirectorState } from "./state.js";
import { runAgent } from "./run-agent.js";
import { runTUI } from "./tui/runner.js";

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
  console.log("  --cwd <dir>        Working directory (default: current directory)");
  console.log("  --max-turns <n>    Maximum agent turns (default: 30)");
  console.log("  --force            Override an existing run state");
  console.log("  --help             Show this help message");
  console.log("");
  console.log("Environment:");
  console.log("  OPENAI_COMPATIBLE_API_KEY      API key for inference provider");
  console.log("  OPENAI_COMPATIBLE_BASE_URL     Provider base URL");
  console.log("  OPENAI_COMPATIBLE_MODEL          Model identifier");
  console.log("  OPENAI_COMPATIBLE_PROVIDER_NAME  Provider name");
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }

  if (args[0] === "resume") {
    args.shift();
    const config = loadConfig(args);
    const previous = await loadState(config.cwd);
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
    const directorState = await loadDirectorState(config.cwd);
    return runAgent({ ...config, task: previous.task }, previous.startedAt, directorState ?? undefined);
  }

  // Strip optional "run" verb
  if (args[0] === "run") {
    args.shift();
  }

  const config = loadConfig(args);
  if (config.tui) {
    return runTUI(config);
  }
  return runAgent(config);
}

const projectRoot = resolve(import.meta.dirname, "..");
await loadEnvFile(resolve(projectRoot, ".env"));

void main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`interchange-code: ${message}`);
    process.exit(1);
  },
);
/* eslint-enable no-console */
