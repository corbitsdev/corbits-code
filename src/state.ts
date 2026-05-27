import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type RunState = {
  status: "running" | "done" | "failed";
  turnsUsed: number;
  task: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
};

const STATE_FILE = ".agent-state/run.json";

export function statePath(cwd: string): string {
  return join(cwd, STATE_FILE);
}

export async function saveState(cwd: string, state: RunState): Promise<void> {
  const path = statePath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2));
}

export async function loadState(cwd: string): Promise<RunState | null> {
  try {
    const raw = await readFile(statePath(cwd), "utf8");
    return JSON.parse(raw) as RunState;
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}
