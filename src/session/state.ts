import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sessionDir } from "./index.js";
import { COMMAND_NAME } from "../branding.js";

export type ConnectedMcpServer = {
  name: string;
  toolCount: number;
};

export type RunState = {
  status: "running" | "done" | "failed" | "cancelled";
  turnsUsed: number;
  task: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  // The resolved "provider:model" identity in use when this record was written.
  // Absent only for records predating this field or written outside the run
  // lifecycle (e.g. a bare rename of a session with no prior state).
  model?: string;
  // MCP servers connected during the session, with the tool count each
  // contributed. Empty until the first server finishes connecting.
  mcpServers?: ConnectedMcpServer[];
};

function statePath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), "run.json");
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
  process.stderr.write(`${COMMAND_NAME}: ignoring unreadable state at ${path} (${reason}); starting fresh\n`);
}

export async function saveState(cwd: string, sessionId: string, state: RunState): Promise<void> {
  await atomicWrite(statePath(cwd, sessionId), JSON.stringify(state, null, 2));
}

function isValidMcpServers(value: unknown): value is ConnectedMcpServer[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).name === "string" &&
      typeof (entry as Record<string, unknown>).toolCount === "number",
  );
}

function isValidRunState(data: unknown): data is RunState {
  if (typeof data !== "object" || data === null) return false;
  const s = data as Record<string, unknown>;
  const validStatuses = ["running", "done", "failed", "cancelled"];
  if (typeof s.status !== "string" || !validStatuses.includes(s.status)) return false;
  if (typeof s.turnsUsed !== "number") return false;
  if (typeof s.task !== "string") return false;
  if (typeof s.startedAt !== "number") return false;
  if (s.finishedAt !== undefined && typeof s.finishedAt !== "number") return false;
  if (s.error !== undefined && typeof s.error !== "string") return false;
  if (s.model !== undefined && typeof s.model !== "string") return false;
  if (s.mcpServers !== undefined && !isValidMcpServers(s.mcpServers)) return false;
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
