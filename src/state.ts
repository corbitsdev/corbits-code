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

function isValidRunState(data: unknown): data is RunState {
  if (typeof data !== "object" || data === null) return false;
  const s = data as Record<string, unknown>;
  const validStatuses = ["running", "done", "failed"];
  if (typeof s.status !== "string" || !validStatuses.includes(s.status)) return false;
  if (typeof s.turnsUsed !== "number") return false;
  if (typeof s.task !== "string") return false;
  if (typeof s.startedAt !== "number") return false;
  if (s.finishedAt !== undefined && typeof s.finishedAt !== "number") return false;
  if (s.error !== undefined && typeof s.error !== "string") return false;
  return true;
}

export async function loadState(cwd: string): Promise<RunState | null> {
  try {
    const raw = await readFile(statePath(cwd), "utf8");
    const parsed = JSON.parse(raw);
    if (!isValidRunState(parsed)) {
      return null;
    }
    return parsed;
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
