/**
 * manage_goal — agent tool for the goal acceptance checklist.
 *
 * Parallel to manage_tasks, but the list is the *goal definition* (what
 * "done" means), not a work plan. Only useful while a session goal is set.
 */

import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";

import type { GoalCriterion, GoalCriterionStatus, GoalGovernor } from "./goal.js";
import { formatGoalStatus, goalCriteriaProgress, GoalCriterionStatusSchema } from "./goal.js";

const ManageGoalArgsSchema = type({
  action: "'create' | 'update'",
  "tasks?": type({
    id: "string>0",
    title: "string>0",
    "status?": GoalCriterionStatusSchema,
    "note?": "string",
  }).array(),
  "updates?": type({
    id: "string>0",
    "title?": "string>0",
    "status?": GoalCriterionStatusSchema,
    "note?": "string",
  }).array(),
});

export type ManageGoalArgs = typeof ManageGoalArgsSchema.infer;

export const manageGoalDefinition: ToolDefinition = {
  name: "manage_goal",
  description:
    "Define or update the session goal's acceptance checklist (what \"done\" means). " +
    "This is not a work plan — use manage_tasks for implementation steps. " +
    "action=\"create\" replaces the full list of concrete, checkable success criteria " +
    "(expand the operator brief into typically 3–12 items — do not restate it as one item). " +
    "action=\"update\" patches items by id (status/title/note). " +
    "The goal is met only when every non-cancelled criterion is done. " +
    "Requires an active /goal.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "update"],
        description: "\"create\" replaces the checklist; \"update\" patches by id.",
      },
      tasks: {
        type: "array",
        description: "For action=\"create\": the full acceptance checklist.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable id (e.g. c1, c2)." },
            title: {
              type: "string",
              description: "Concrete, independently checkable acceptance criterion.",
            },
            status: {
              type: "string",
              enum: ["todo", "doing", "done", "blocked", "cancelled"],
              description: "Defaults to \"todo\".",
            },
            note: { type: "string", description: "Optional evidence when done/blocked." },
          },
          required: ["id", "title"],
        },
      },
      updates: {
        type: "array",
        description: "For action=\"update\": per-criterion patches.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            status: {
              type: "string",
              enum: ["todo", "doing", "done", "blocked", "cancelled"],
            },
            note: { type: "string" },
          },
          required: ["id"],
        },
      },
    },
    required: ["action"],
  },
};

export function parseManageGoalArgs(rawArgs: unknown): ManageGoalArgs | null {
  const result = ManageGoalArgsSchema(rawArgs);
  return result instanceof type.errors ? null : result;
}

function summarize(snap: NonNullable<ReturnType<GoalGovernor["get"]>>): string {
  const progress = goalCriteriaProgress(snap.criteria);
  const phase = snap.phase;
  const head =
    snap.status === "achieved"
      ? `Goal achieved — all ${progress.total} acceptance criteria done.`
      : `Goal checklist updated (${progress.done}/${progress.total} done, phase=${phase}).`;
  return `${head}\n${formatGoalStatus(snap)}`;
}

/**
 * Build the manage_goal AgentTool. `getGovernor` is read on each call so the
 * tool can be registered before the governor exists and still work once wired.
 */
export function createManageGoalTool(getGovernor: () => GoalGovernor | null): AgentTool {
  return stringTool({
    definition: manageGoalDefinition,
    handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
      const parsed = parseManageGoalArgs(rawArgs);
      if (parsed === null) {
        return "Error: manage_goal requires action ('create' or 'update').";
      }
      const gov = getGovernor();
      if (gov === null) {
        return "Error: no goal is set. Use /goal <brief> first.";
      }
      const current = gov.get();
      if (current === null) {
        return "Error: no goal is set. Use /goal <brief> first.";
      }

      if (parsed.action === "create") {
        const tasks = parsed.tasks ?? [];
        if (tasks.length === 0) {
          return 'Error: action="create" requires a non-empty tasks array of acceptance criteria.';
        }
        const ids = new Set<string>();
        for (const t of tasks) {
          if (ids.has(t.id)) return `Error: duplicate criterion id: ${t.id}`;
          ids.add(t.id);
        }
        const criteria: GoalCriterion[] = tasks.map((t) => ({
          id: t.id,
          title: t.title.trim(),
          status: (t.status ?? "todo") as GoalCriterionStatus,
          ...(t.note !== undefined && t.note.length > 0 ? { note: t.note } : {}),
        }));
        const snap = gov.setCriteria(criteria);
        if (snap === null) return "Error: no goal is set.";
        return summarize(snap);
      }

      const updates = parsed.updates ?? [];
      if (updates.length === 0) {
        return 'Error: action="update" requires a non-empty updates array.';
      }
      const known = new Set(current.criteria.map((c) => c.id));
      for (const u of updates) {
        if (!known.has(u.id)) {
          return `Error: unknown criterion id: ${u.id}. Known: ${[...known].join(", ") || "(none)"}`;
        }
      }
      const snap = gov.updateCriteria(
        updates.map((u) => ({
          id: u.id,
          ...(u.title !== undefined ? { title: u.title } : {}),
          ...(u.status !== undefined ? { status: u.status as GoalCriterionStatus } : {}),
          ...(u.note !== undefined ? { note: u.note } : {}),
        })),
      );
      if (snap === null) return "Error: no goal is set.";
      return summarize(snap);
    },
  });
}
