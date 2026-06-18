import { type } from "arktype";
import type { ToolDefinition } from "@intx/types/runtime";

// A task is a unit of work the agent registered for itself. The agent owns the
// list — it adds items on receipt of a multi-step command and updates each
// item's status as work progresses.
export const TaskStatusSchema = type("'todo' | 'doing' | 'done'");
export type TaskStatus = typeof TaskStatusSchema.infer;

export const TaskSchema = type({
  id: "string>0",
  title: "string>0",
  status: TaskStatusSchema,
});
export type Task = typeof TaskSchema.infer;

// `create` overwrites the list; `update` patches individual tasks by id.
// One multi-purpose tool keeps the schema surface small.
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
    "Maintain your own ordered task list for multi-step work. Call with action=\"create\" and an ordered list of tasks at the start of a non-trivial command to register what you intend to do. Call with action=\"update\" and per-task patches as you make progress (status transitions: todo → doing → done; title edits when scope sharpens). Skip this tool for trivial single-step changes.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "update"],
        description: "\"create\" replaces the list; \"update\" patches individual tasks by id.",
      },
      tasks: {
        type: "array",
        description: "For action=\"create\": the new ordered task list.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable id, unique within this list (e.g. t1, t2)." },
            title: { type: "string", description: "Short, action-oriented description." },
            status: { type: "string", enum: ["todo", "doing", "done"], description: "Defaults to \"todo\" when omitted." },
          },
          required: ["id", "title"],
        },
      },
      updates: {
        type: "array",
        description: "For action=\"update\": per-task patches.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Id of an existing task." },
            title: { type: "string" },
            status: { type: "string", enum: ["todo", "doing", "done"] },
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

// Apply a parsed call to a task list, returning the active list. Completed
// tasks are removed so the task panel stays focused on remaining work.
export function applyManageTasks(current: Task[], args: ManageTasksArgs): Task[] {
  if (args.action === "create") {
    const tasks = args.tasks ?? [];
    return tasks
      .map((t) => ({ id: t.id, title: t.title, status: t.status ?? "todo" }))
      .filter((task) => task.status !== "done");
  }
  const updates = args.updates ?? [];
  if (updates.length === 0) return current;
  const byId = new Map(updates.map((u) => [u.id, u]));
  return current
    .map((task) => {
      const patch = byId.get(task.id);
      if (patch === undefined) return task;
      return {
        id: task.id,
        title: patch.title ?? task.title,
        status: patch.status ?? task.status,
      };
    })
    .filter((task) => task.status !== "done");
}
