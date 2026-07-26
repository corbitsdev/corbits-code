import { mkdir, writeFile, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type } from "arktype";

import { sessionDir } from "./index.js";
import { GoalCriterionSchema, GoalStatusSchema } from "../agent/goal.js";
import { atomicWrite, warnUnreadableState } from "./state.js";

const PersistedGoalStateSchema = type({
  status: GoalStatusSchema,
  condition: "string",
  /** Operator brief; falls back to condition for older goal.json files. */
  "brief?": "string",
  /** Expanded acceptance checklist. */
  "criteria?": GoalCriterionSchema.array(),
  startedAt: "number",
  /** Wall-clock when status flipped to achieved (freezes completion duration). */
  "completedAt?": "number",
  turnBudget: "number",
  turnsUsed: "number",
  "tokenBudget?": "number",
  mainTokens: "number",
  evalTokens: "number",
  "lastReason?": "string",
});

export type PersistedGoalState = typeof PersistedGoalStateSchema.infer;

function goalPath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), "goal.json");
}

// Returns the parsed state, or the arktype error summary when the shape is
// invalid, so callers can surface a specific reason rather than "invalid shape".
function parsePersistedGoal(data: unknown): PersistedGoalState | { error: string } {
  const result = PersistedGoalStateSchema(data);
  return result instanceof type.errors ? { error: result.summary } : result;
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
    const parsed = parsePersistedGoal(JSON.parse(raw));
    if ("error" in parsed) {
      warnUnreadableState(path, `invalid shape: ${parsed.error}`);
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
