import { Box, Text } from "ink";
import type { Task, TaskStatus } from "../../agent/tasks.js";
import { color } from "../theme.js";

export type TaskViewProps = {
  tasks: Task[];
  compact?: boolean;
  title?: string;
};

// Checkbox glyphs make task state legible at a glance: an empty box for pending
// work, a half-filled box for the item in flight, and a checked box once done.
const GLYPH: Record<TaskStatus, string> = {
  todo: "☐",
  doing: "◐",
  done: "☑",
};

export function TaskView({ tasks, compact, title = "Tasks" }: TaskViewProps) {
  if (tasks.length === 0) return null;

  const sorted = [...tasks].sort(byPriority);

  if (compact) {
    const active = sorted.filter((t) => t.status !== "done");
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
  const rank: Record<TaskStatus, number> = { doing: 0, todo: 1, done: 2 };
  return rank[a.status] - rank[b.status];
}

function statusColor(status: TaskStatus): string {
  switch (status) {
    case "done":
      return color("success");
    case "doing":
      return color("accent");
    case "todo":
      return color("muted");
  }
}
