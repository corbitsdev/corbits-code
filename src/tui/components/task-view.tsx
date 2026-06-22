import { Box, Text } from "ink";
import type { Task, TaskStatus } from "../../agent/tasks.js";
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

export function TaskView({ tasks, compact, title = "Tasks" }: TaskViewProps) {
  if (tasks.length === 0) return null;

  const sorted = [...tasks].sort(byPriority);

  if (compact) {
    const active = sorted.filter((t) => t.status !== "done" && t.status !== "cancelled");
    if (active.length === 0) return null;
    const doing = active.find((t) => t.status === "doing");
    const current = doing ?? active[0]!;
    const remaining = active.length - 1;

    return (
      <Box paddingX={1} gap={1}>
        <Text color={statusColor(current.status)}>{GLYPH[current.status]}</Text>
        <Text wrap="truncate-end">{current.title}</Text>
        {remaining > 0 && <Text color={color("dim")} dimColor>{`+${remaining}`}</Text>}
      </Box>
    );
  }

  const doneCount = sorted.filter((t) => t.status === "done").length;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box gap={1}>
        <Text bold color={color("accent")}>{title}</Text>
        <Text color={color("dim")} dimColor>{`${doneCount}/${sorted.length}`}</Text>
      </Box>
      {sorted.map((task) => (
        <Box key={task.id} gap={1}>
          <Text color={statusColor(task.status)}>{GLYPH[task.status]}</Text>
          <Text
            {...(task.status === "done" ? { color: color("dim"), strikethrough: true } : {})}
            bold={task.status === "doing"}
            wrap="truncate-end"
          >
            {task.title}
          </Text>
        </Box>
      ))}
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
