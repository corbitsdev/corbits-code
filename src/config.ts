import { resolve } from "node:path";

export type Config = {
  apiKey: string;
  baseURL: string;
  model: string;
  providerName: string;
  cwd: string;
  maxTurns: number;
  task: string;
  force: boolean;
  tui: boolean;
};

const DEFAULT_MAX_TURNS = 30;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} env var is required`);
  }
  return value;
}

export function loadConfig(argv: readonly string[]): Config {
  const args = [...argv];

  let cwd = process.cwd();
  let maxTurns = DEFAULT_MAX_TURNS;
  let force = false;
  let tui = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--cwd") {
      const next = args[++i];
      if (next === undefined) {
        throw new Error("--cwd requires a directory path");
      }
      cwd = resolve(next);
      continue;
    }
    if (arg === "--max-turns") {
      const next = args[++i];
      if (next === undefined) {
        throw new Error("--max-turns requires a number");
      }
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`invalid --max-turns: ${next}`);
      }
      maxTurns = parsed;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--tui") {
      tui = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`unrecognized flag: ${arg}`);
    }
    positional.push(arg);
  }

  const apiKey = requireEnv("OPENAI_COMPATIBLE_API_KEY");
  const baseURL = requireEnv("OPENAI_COMPATIBLE_BASE_URL");
  const model = requireEnv("OPENAI_COMPATIBLE_MODEL");
  const providerName = requireEnv("OPENAI_COMPATIBLE_PROVIDER_NAME");

  const task = positional.join(" ").trim();
  if (task.length === 0) {
    throw new Error("task description is required");
  }

  return {
    apiKey,
    baseURL,
    model,
    providerName,
    cwd,
    maxTurns,
    task,
    force,
    tui,
  };
}
