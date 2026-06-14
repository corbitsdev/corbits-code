import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { sessionDir } from "../session/index.js";
import { atomicWrite, warnUnreadableState } from "../session/state.js";
import type { StepStatus, WorkflowState } from "./types.js";

const STEP_STATUSES: StepStatus[] = ["pending", "active", "completed", "skipped"];

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
    if (typeof f.stepIndex !== "number") return false;
    if (!Array.isArray(f.statuses)) return false;
    for (const status of f.statuses) {
      if (typeof status !== "string" || !STEP_STATUSES.includes(status as StepStatus)) {
        return false;
      }
    }
  }
  return true;
}

export async function saveWorkflowState(
  cwd: string,
  sessionId: string,
  state: WorkflowState,
): Promise<void> {
  await atomicWrite(workflowStatePath(cwd, sessionId), JSON.stringify(state, null, 2));
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
