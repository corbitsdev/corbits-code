import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";

export type Mode = "manager" | "teammate";

export type Config = {
  apiKey: string;
  baseURL: string;
  model: string;
  providerName: string;
  cwd: string;
  task: string;
  force: boolean;
  headless: boolean;
  mode: Mode;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} env var is required`);
  }
  return value;
}

function loadModeFromFile(): Mode | undefined {
  const configPath = join(homedir(), ".interchange", "config.json");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const m = (parsed as Record<string, unknown>).mode;
      if (m === "manager" || m === "teammate") return m;
    }
  } catch {
    // file absent or unreadable — use default
  }
  return undefined;
}

export function loadConfig(argv: readonly string[]): Config {
  const args = [...argv];

  let cwd = process.cwd();
  let force = false;
  let headless = false;
  let modeOverride: Mode | undefined;
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
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--headless" || arg === "-h") {
      headless = true;
      continue;
    }
    if (arg === "--mode") {
      const next = args[++i];
      if (next !== "manager" && next !== "teammate") {
        throw new Error('--mode requires "manager" or "teammate"');
      }
      modeOverride = next;
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
  const mode = modeOverride ?? loadModeFromFile() ?? "teammate";

  return {
    apiKey,
    baseURL,
    model,
    providerName,
    cwd,
    task,
    force,
    headless,
    mode,
  };
}
