import { type } from "arktype";
import type { ToolDefinition } from "@intx/types/runtime";

// A task is a unit of work the agent registered for itself. The agent owns the
// list — it adds, renames, cancels, and status-updates items mid-run.
export const TaskStatusSchema = type("'todo' | 'doing' | 'done' | 'cancelled'");
export type TaskStatus = typeof TaskStatusSchema.infer;

// GLM (and other Claude-shaped) payloads send in_progress; map it at the
// boundary so stored tasks stay on the todo/doing/done/cancelled enum.
const TaskStatusInput = type(
  "'todo' | 'doing' | 'done' | 'cancelled' | 'in_progress'",
).pipe((s): TaskStatus => (s === "in_progress" ? "doing" : s));

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
    "status?": TaskStatusInput,
  }).array(),
  "updates?": type({
    id: "string>0",
    "title?": "string>0",
    "status?": TaskStatusInput,
  }).array(),
});

export type ManageTasksArgs = typeof ManageTasksArgsSchema.infer;

export const manageTasksDefinition: ToolDefinition = {
  name: "manage_tasks",
  description:
    "Your work checklist for multi-step jobs. create replaces the list; update patches by id (status todo|doing|done|cancelled) and appends unknown ids that have a title. Skip for one-step work.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "update"],
        description: "create or update.",
      },
      tasks: {
        type: "array",
        description: "Full list (create).",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Unique id.",
            },
            title: {
              type: "string",
              description: "Action title.",
            },
            status: {
              type: "string",
              enum: ["todo", "doing", "done", "cancelled"],
              description: "Default todo.",
            },
          },
          required: ["id", "title"],
        },
      },
      updates: {
        type: "array",
        description: "Patches (update).",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Task id.",
            },
            title: {
              type: "string",
              description: "Required for new ids.",
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
// Clone first: arktype's in_progress→doing morph writes onto the input, and
// reactor snapshots deep-freeze tool_call.arguments before decide() runs.
export function parseManageTasksArgs(rawArgs: unknown): ManageTasksArgs | null {
  const result = ManageTasksArgsSchema(cloneManageTasksInput(rawArgs));
  return result instanceof type.errors ? null : result;
}

function cloneManageTasksInput(rawArgs: unknown): unknown {
  if (rawArgs === null || typeof rawArgs !== "object") return rawArgs;
  try {
    return JSON.parse(JSON.stringify(rawArgs));
  } catch {
    return rawArgs;
  }
}

function tasksEqual(a: Task[], b: Task[]): boolean {
  return (
    a.length === b.length &&
    a.every((t, i) => {
      const o = b[i];
      return (
        o !== undefined &&
        t.id === o.id &&
        t.title === o.title &&
        t.status === o.status
      );
    })
  );
}

// Returns the model-facing note when a call changes nothing, else null.
function describeManageTasksNoOp(
  current: Task[],
  args: ManageTasksArgs,
): string | null {
  if (args.action === "create") {
    return tasksEqual(current, applyManageTasks(current, args))
      ? "No change: task list already matches."
      : null;
  }
  const updates = args.updates ?? [];
  if (updates.length === 0) return "No change: no updates supplied.";
  const noOps: string[] = [];
  let changed = false;
  for (const patch of updates) {
    const existing = current.find((t) => t.id === patch.id);
    if (existing === undefined) {
      if (patch.title !== undefined && patch.title.length > 0) changed = true;
      else noOps.push(`${patch.id} not found`);
    } else if (
      (patch.title ?? existing.title) === existing.title &&
      (patch.status ?? existing.status) === existing.status
    ) {
      noOps.push(`${patch.id} already ${existing.status}`);
    } else {
      changed = true;
    }
  }
  return changed ? null : `No change: ${noOps.join("; ")}.`;
}

export type ManageTasksRunner = (rawArgs: Record<string, unknown>) => Promise<{
  content: string;
  isError?: boolean;
}>;

// The director already applied this call when it observed the tool_call, so
// the runner keeps its own copy; a repeat call that changes nothing still
// returns a distinct result instead of "Tasks updated."
export function createManageTasksRunner(): ManageTasksRunner {
  let tasks: Task[] = [];
  return async (rawArgs) => {
    const parsed = ManageTasksArgsSchema(cloneManageTasksInput(rawArgs));
    if (parsed instanceof type.errors) {
      return {
        content: `Error: manage_tasks arguments invalid: ${parsed.summary}`,
        isError: true,
      };
    }
    const noOp = describeManageTasksNoOp(tasks, parsed);
    tasks = applyManageTasks(tasks, parsed);
    return { content: noOp ?? "Tasks updated." };
  };
}

// Apply a parsed call to a task list, returning the full list. Completed tasks
// are retained so the task view can show them checked off as work progresses.
export function applyManageTasks(
  current: Task[],
  args: ManageTasksArgs,
): Task[] {
  if (args.action === "create") {
    const tasks = args.tasks ?? [];
    return tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status ?? "todo",
    }));
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
