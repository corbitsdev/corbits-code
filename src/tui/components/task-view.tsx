import { Box, Text } from "ink";
import { hasActiveTasks, type Task, type TaskStatus } from "../../agent/tasks.js";
import { color } from "../theme.js";

export type TaskViewProps = {
  tasks: Task[];
  compact?: boolean;
  title?: string;
};

const GLYPH: Record<TaskStatus, string> = {
  todo: "○",
  doing: "●",
  done: "✓",
  cancelled: "✗",
};

/**
 * Work/Tasks checklist chrome.
 * Rows are width-constrained so long titles truncate after the status glyph
 * instead of colliding with the header (`Work 03/11`) or neighboring lines.
 */
export function TaskView({ tasks, compact, title = "Tasks" }: TaskViewProps) {
  if (!hasActiveTasks(tasks)) return null;

  const sorted = [...tasks].sort(byPriority);

  if (compact) {
    const active = sorted.filter((t) => t.status !== "done" && t.status !== "cancelled");
    const doing = active.find((t) => t.status === "doing");
    const current = doing ?? active[0]!;
    const remaining = active.length - 1;

    return (
      <Box width="100%" paddingX={1} gap={1} overflow="hidden">
        <Box flexShrink={0}>
          <Text color={statusColor(current.status)}>{GLYPH[current.status]}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <Text bold={current.status === "doing"} wrap="truncate-end">
            {current.title}
          </Text>
        </Box>
        {remaining > 0 && (
          <Box flexShrink={0}>
            <Text color={color("dim")} dimColor>{`+${remaining}`}</Text>
          </Box>
        )}
      </Box>
    );
  }

  const doneCount = sorted.filter((t) => t.status === "done").length;
  // Single Text node for the heading so "Work" and "03/11" cannot overprint.
  const heading = `${title} ${doneCount}/${sorted.length}`;

  return (
    <Box flexDirection="column" width="100%" paddingX={1} overflow="hidden">
      <Box width="100%" overflow="hidden">
        <Text bold color={color("muted")} wrap="truncate-end">
          {heading}
        </Text>
      </Box>
      {sorted.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
    </Box>
  );
}

function TaskRow({ task }: { task: Task }) {
  const terminal = task.status === "done" || task.status === "cancelled";
  return (
    <Box width="100%" gap={1} overflow="hidden">
      <Box flexShrink={0}>
        <Text color={statusColor(task.status)}>{GLYPH[task.status]}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        <Text
          {...(terminal ? { color: color("dim"), strikethrough: true } : {})}
          bold={task.status === "doing"}
          wrap="truncate-end"
        >
          {task.title}
        </Text>
      </Box>
    </Box>
  );
}

function byPriority(a: Task, b: Task): number {
  const rank: Record<TaskStatus, number> = { doing: 0, todo: 1, cancelled: 2, done: 3 };
  return rank[a.status] - rank[b.status];
}

function statusColor(status: TaskStatus): string {
  switch (status) {
    case "done":
      return color("success");
    case "doing":
      return color("text");
    case "cancelled":
      return color("danger");
    case "todo":
      return color("muted");
  }
}
