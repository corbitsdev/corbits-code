import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { sessionDir } from "../session/index.js";
import { atomicWrite, warnUnreadableState } from "../session/state.js";
import type { StepStatus, WorkflowState } from "./types.js";
import { COMMAND_NAME } from "../branding.js";

const STEP_STATUSES: StepStatus[] = ["pending", "active", "completed", "skipped"];

const writeChains = new Map<string, Promise<void>>();

function workflowStatePath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), "workflow.json");
}

function isValidWorkflowState(data: unknown): data is WorkflowState {
  if (typeof data !== "object" || data === null) return false;
  const s = data as Record<string, unknown>;
  if (typeof s.completed !== "boolean") return false;
  if (!Array.isArray(s.stack)) return false;
  for (const frame of s.stack) {
    if (typeof frame !== "object" || frame === null) return false;
    const f = frame as Record<string, unknown>;
    if (typeof f.workflow !== "string") return false;
    if (typeof f.stepIndex !== "number" || !Number.isInteger(f.stepIndex) || f.stepIndex < 0) {
      return false;
    }
    if (!Array.isArray(f.statuses)) return false;
    for (const status of f.statuses) {
      if (typeof status !== "string" || !STEP_STATUSES.includes(status as StepStatus)) {
        return false;
      }
    }
  }
  return true;
}

/** Surface a failed workflow.json write instead of dropping it silently. */
export function warnWorkflowPersistenceFailure(path: string, reason: string): void {
  process.stderr.write(`${COMMAND_NAME}: failed to persist workflow state at ${path} (${reason})\n`);
}

export async function saveWorkflowState(
  cwd: string,
  sessionId: string,
  state: WorkflowState,
): Promise<void> {
  const path = workflowStatePath(cwd, sessionId);
  const payload = JSON.stringify(state, null, 2);
  const run = (): Promise<void> => atomicWrite(path, payload);
  const chained = (writeChains.get(path) ?? Promise.resolve()).then(run, run);
  writeChains.set(path, chained.catch(() => undefined));
  await chained;
}

/** Await any in-flight save for this session (used by tests and shutdown paths). */
export async function flushWorkflowStateWrites(cwd: string, sessionId: string): Promise<void> {
  const path = workflowStatePath(cwd, sessionId);
  await (writeChains.get(path) ?? Promise.resolve());
}

export async function loadWorkflowState(
  cwd: string,
  sessionId: string,
): Promise<WorkflowState | null> {
  const path = workflowStatePath(cwd, sessionId);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!isValidWorkflowState(parsed)) {
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
