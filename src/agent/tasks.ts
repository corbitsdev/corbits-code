import { type } from "arktype";
import type { ToolDefinition } from "@intx/types/runtime";

// A task is a unit of work the agent registered for itself. The agent owns the
// list — it adds, renames, cancels, and status-updates items as the plan
// evolves mid-run (especially under /goal Work vs Acceptance).
export const TaskStatusSchema = type("'todo' | 'doing' | 'done' | 'cancelled'");
export type TaskStatus = typeof TaskStatusSchema.infer;

export const TaskSchema = type({
  id: "string>0",
  title: "string>0",
  status: TaskStatusSchema,
});
export type Task = typeof TaskSchema.infer;

// A task list has active work while any task is still todo or doing. Terminal
// tasks (done/cancelled) are resolved, so an all-terminal list is finished.
export function hasActiveTasks(tasks: Task[]): boolean {
  return tasks.some((t) => t.status !== "done" && t.status !== "cancelled");
}

// `create` overwrites the list; `update` patches by id and may append new
// items (unknown id + title). One multi-purpose tool keeps the schema small.
const ManageTasksArgsSchema = type({
  action: "'create' | 'update'",
  "tasks?": type({
    id: "string>0",
    title: "string>0",
    "status?": TaskStatusSchema,
  }).array(),
  "updates?": type({
    id: "string>0",
    "title?": "string>0",
    "status?": TaskStatusSchema,
  }).array(),
});

export type ManageTasksArgs = typeof ManageTasksArgsSchema.infer;

export const manageTasksDefinition: ToolDefinition = {
  name: "manage_tasks",
  description:
    "Maintain your own ordered work list for multi-step jobs. " +
    "action=\"create\" replaces the full list (use to seed or replan). " +
    "action=\"update\" patches by id: status (todo→doing→done/cancelled), title edits, " +
    "and appends when the id is new and title is set. " +
    "Keep this list live — add, cancel, and re-title steps as you learn more. " +
    "Under /goal this is Work (how you get there); manage_goal is Acceptance (what done means). " +
    "Skip for trivial single-step changes.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "update"],
        description:
          "\"create\" replaces the list; \"update\" patches by id and can append new tasks (id + title).",
      },
      tasks: {
        type: "array",
        description: "For action=\"create\": the new ordered task list (full replace).",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable id, unique within this list (e.g. t1, t2)." },
            title: { type: "string", description: "Short, action-oriented description." },
            status: {
              type: "string",
              enum: ["todo", "doing", "done", "cancelled"],
              description: "Defaults to \"todo\" when omitted.",
            },
          },
          required: ["id", "title"],
        },
      },
      updates: {
        type: "array",
        description:
          "For action=\"update\": per-task patches. Unknown id + title appends a new task; " +
          "status \"cancelled\" removes it from active work.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Id of an existing task, or a new id to append." },
            title: {
              type: "string",
              description: "Required when appending a new id; optional rename for existing.",
            },
            status: {
              type: "string",
              enum: ["todo", "doing", "done", "cancelled"],
            },
          },
          required: ["id"],
        },
      },
    },
    required: ["action"],
  },
};

// Parse the raw tool arguments. Returns null when invalid so callers can skip.
export function parseManageTasksArgs(rawArgs: unknown): ManageTasksArgs | null {
  const result = ManageTasksArgsSchema(rawArgs);
  return result instanceof type.errors ? null : result;
}

// Apply a parsed call to a task list, returning the full list. Completed tasks
// are retained so the task view can show them checked off as work progresses.
export function applyManageTasks(current: Task[], args: ManageTasksArgs): Task[] {
  if (args.action === "create") {
    const tasks = args.tasks ?? [];
    return tasks.map((t) => ({ id: t.id, title: t.title, status: t.status ?? "todo" }));
  }
  const updates = args.updates ?? [];
  if (updates.length === 0) return current;

  const existingIds = new Set(current.map((t) => t.id));
  const byId = new Map(updates.map((u) => [u.id, u]));

  const next = current.map((task) => {
    const patch = byId.get(task.id);
    if (patch === undefined) return task;
    return {
      id: task.id,
      title: patch.title ?? task.title,
      status: patch.status ?? task.status,
    };
  });

  // Append new work items discovered mid-run (id not already in the list).
  for (const patch of updates) {
    if (existingIds.has(patch.id)) continue;
    if (patch.title === undefined || patch.title.length === 0) continue;
    next.push({
      id: patch.id,
      title: patch.title,
      status: patch.status ?? "todo",
    });
  }
  return next;
}
