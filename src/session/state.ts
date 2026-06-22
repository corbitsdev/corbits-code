import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sessionDir } from "./index.js";

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
  tasks: Array<{ id: string; title: string; status: "todo" | "doing" | "done" | "cancelled" }>;
  terminated?: boolean;
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
  if (!Array.isArray(s.tasks)) return false;
  for (const task of s.tasks) {
    if (typeof task !== "object" || task === null) return false;
    const t = task as Record<string, unknown>;
    if (typeof t.id !== "string") return false;
    if (typeof t.title !== "string") return false;
    if (typeof t.status !== "string") return false;
    if (!["todo", "doing", "done"].includes(t.status)) return false;
  }
  return true;
}

function statePath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), "run.json");
}

function directorStatePath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), "director.json");
}

let tmpWriteCounter = 0;

// Write atomically: serialize to a unique temp file, then rename into place so a
// crash mid-write never leaves torn JSON. The temp name combines the pid with a
// monotonic counter so concurrent or rapid successive saves within one process
// never collide on the same temp path (pid alone is not unique per call).
export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${(tmpWriteCounter += 1)}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

// A corrupt or shape-invalid state file means resume is silently starting over
// and prior progress is being discarded. Surface it rather than swallowing it.
export function warnUnreadableState(path: string, reason: string): void {
  process.stderr.write(`intercode: ignoring unreadable state at ${path} (${reason}); starting fresh\n`);
}

export async function saveDirectorState(
  cwd: string,
  sessionId: string,
  state: DirectorPersistedState,
): Promise<void> {
  await atomicWrite(directorStatePath(cwd, sessionId), JSON.stringify(state, null, 2));
}

export async function loadDirectorState(
  cwd: string,
  sessionId: string,
): Promise<DirectorPersistedState | null> {
  const path = directorStatePath(cwd, sessionId);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!isValidDirectorState(parsed)) {
      warnUnreadableState(path, "invalid shape");
      return null;
    }
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) {
      warnUnreadableState(path, "corrupt JSON");
      return null;
    }
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
  await atomicWrite(statePath(cwd, sessionId), JSON.stringify(state, null, 2));
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
  const path = statePath(cwd, sessionId);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!isValidRunState(parsed)) {
      warnUnreadableState(path, "invalid shape");
      return null;
    }
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) {
      warnUnreadableState(path, "corrupt JSON");
      return null;
    }
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
