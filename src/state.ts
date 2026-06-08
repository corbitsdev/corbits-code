import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sessionDir } from "./session.js";

export type RunState = {
  status: "running" | "done" | "failed";
  turnsUsed: number;
  task: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
};

export type DirectorPersistedState = {
  turnsUsed: number;
  submitCalled: boolean;
  callIdToName: Record<string, string>;
  idleCycles: number;
  planSubmitted: boolean;
  plan: Array<{ file: string; action: string; reason: string }>;
  filesRead?: Array<{ path: string; turn: number }>;
};

function isValidDirectorState(data: unknown): data is DirectorPersistedState {
  if (typeof data !== "object" || data === null) return false;
  const s = data as Record<string, unknown>;
  if (typeof s.turnsUsed !== "number") return false;
  if (typeof s.submitCalled !== "boolean") return false;
  if (typeof s.callIdToName !== "object" || s.callIdToName === null) return false;
  for (const v of Object.values(s.callIdToName)) {
    if (typeof v !== "string") return false;
  }
  if (typeof s.idleCycles !== "number") return false;
  if (typeof s.planSubmitted !== "boolean") return false;
  if (!Array.isArray(s.plan)) return false;
  for (const step of s.plan) {
    if (typeof step !== "object" || step === null) return false;
    const st = step as Record<string, unknown>;
    if (typeof st.file !== "string") return false;
    if (typeof st.action !== "string") return false;
    if (typeof st.reason !== "string") return false;
  }
  return true;
}

function statePath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), "run.json");
}

function directorStatePath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), "director.json");
}

export async function saveDirectorState(
  cwd: string,
  sessionId: string,
  state: DirectorPersistedState,
): Promise<void> {
  const path = directorStatePath(cwd, sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2));
}

export async function loadDirectorState(
  cwd: string,
  sessionId: string,
): Promise<DirectorPersistedState | null> {
  try {
    const raw = await readFile(directorStatePath(cwd, sessionId), "utf8");
    const parsed = JSON.parse(raw);
    if (!isValidDirectorState(parsed)) {
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

export async function saveState(cwd: string, sessionId: string, state: RunState): Promise<void> {
  const path = statePath(cwd, sessionId);
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

export async function loadState(cwd: string, sessionId: string): Promise<RunState | null> {
  try {
    const raw = await readFile(statePath(cwd, sessionId), "utf8");
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
