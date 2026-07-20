import { mkdir, writeFile, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sessionDir } from "./index.js";
import type { GoalCriterion, GoalCriterionStatus, GoalStatus } from "../agent/goal.js";
import { atomicWrite, warnUnreadableState } from "./state.js";

export type PersistedGoalState = {
  status: GoalStatus;
  condition: string;
  /** Operator brief; falls back to condition for older goal.json files. */
  brief?: string;
  /** Expanded acceptance checklist. */
  criteria?: GoalCriterion[];
  startedAt: number;
  /** Wall-clock when status flipped to achieved (freezes completion duration). */
  completedAt?: number;
  turnBudget: number;
  turnsUsed: number;
  tokenBudget?: number;
  mainTokens: number;
  evalTokens: number;
  lastReason?: string;
};

function goalPath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), "goal.json");
}

const VALID_STATUSES: readonly GoalStatus[] = [
  "inactive",
  "active",
  "paused",
  "achieved",
  "cleared",
  "budget_limited",
  "blocked",
];

const VALID_CRITERION_STATUSES: readonly GoalCriterionStatus[] = [
  "todo",
  "doing",
  "done",
  "blocked",
  "cancelled",
];

function isValidCriterion(data: unknown): data is GoalCriterion {
  if (typeof data !== "object" || data === null) return false;
  const c = data as Record<string, unknown>;
  if (typeof c.id !== "string" || c.id.length === 0) return false;
  if (typeof c.title !== "string" || c.title.length === 0) return false;
  if (
    typeof c.status !== "string" ||
    !VALID_CRITERION_STATUSES.includes(c.status as GoalCriterionStatus)
  ) {
    return false;
  }
  if (c.note !== undefined && typeof c.note !== "string") return false;
  return true;
}

function isValidPersistedGoal(data: unknown): data is PersistedGoalState {
  if (typeof data !== "object" || data === null) return false;
  const s = data as Record<string, unknown>;
  if (typeof s.status !== "string" || !VALID_STATUSES.includes(s.status as GoalStatus)) return false;
  if (typeof s.condition !== "string") return false;
  if (s.brief !== undefined && typeof s.brief !== "string") return false;
  if (s.criteria !== undefined) {
    if (!Array.isArray(s.criteria)) return false;
    if (!s.criteria.every(isValidCriterion)) return false;
  }
  if (typeof s.startedAt !== "number") return false;
  if (s.completedAt !== undefined && typeof s.completedAt !== "number") return false;
  if (typeof s.turnBudget !== "number") return false;
  if (typeof s.turnsUsed !== "number") return false;
  if (s.tokenBudget !== undefined && typeof s.tokenBudget !== "number") return false;
  if (typeof s.mainTokens !== "number") return false;
  if (typeof s.evalTokens !== "number") return false;
  if (s.lastReason !== undefined && typeof s.lastReason !== "string") return false;
  return true;
}

export async function saveGoalState(
  cwd: string,
  sessionId: string,
  state: PersistedGoalState | null,
): Promise<void> {
  const path = goalPath(cwd, sessionId);
  if (state === null || state.status === "inactive" || state.status === "cleared") {
    try {
      await unlink(path);
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: unknown }).code === "ENOENT"
      ) {
        return;
      }
      throw err;
    }
    return;
  }
  await atomicWrite(path, JSON.stringify(state, null, 2));
}

export async function loadGoalState(
  cwd: string,
  sessionId: string,
): Promise<PersistedGoalState | null> {
  const path = goalPath(cwd, sessionId);
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isValidPersistedGoal(parsed)) {
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

// Re-export mkdir helpers for tests that want to seed a goal file without going
// through saveGoalState (e.g. corrupt-file cases). Not used in production.
export async function writeGoalStateRaw(
  cwd: string,
  sessionId: string,
  content: string,
): Promise<void> {
  const path = goalPath(cwd, sessionId);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}
