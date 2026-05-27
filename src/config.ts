import { resolve } from "node:path";

export type Config = {
  apiKey: string;
  baseURL: string;
  model: string;
  cwd: string;
  maxTurns: number;
  task: string;
};

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_MODEL = "default-model";
const DEFAULT_MAX_TURNS = 30;

export function loadConfig(argv: readonly string[]): Config {
  const args = [...argv];

  let cwd = process.cwd();
  let maxTurns = DEFAULT_MAX_TURNS;
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
    if (arg.startsWith("--")) {
      throw new Error(`unrecognized flag: ${arg}`);
    }
    positional.push(arg);
  }

  const apiKey = process.env.XAI_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("XAI_API_KEY env var is required");
  }

  const baseURL = process.env.XAI_BASE_URL ?? DEFAULT_BASE_URL;
  const model = process.env.XAI_MODEL ?? DEFAULT_MODEL;

  const task = positional.join(" ").trim();
  if (task.length === 0) {
    throw new Error("task description is required");
  }

  return {
    apiKey,
    baseURL,
    model,
    cwd,
    maxTurns,
    task,
  };
}
