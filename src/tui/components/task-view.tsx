import { Box, Text } from "ink";
import type { Task } from "../../agent/tasks.js";
import { color } from "../theme.js";

export type TaskViewProps = {
  tasks: Task[];
  compact?: boolean;
};

export function TaskView({ tasks, compact }: TaskViewProps) {
  const activeTasks = tasks.filter((task) => task.status !== "done");
  if (activeTasks.length === 0) return null;

  const sorted = [...activeTasks].sort(byPriority);

  if (compact) {
    const doing = sorted.find((t) => t.status === "doing");
    const todoCount = sorted.filter((t) => t.status === "todo").length;
    const current = doing ?? sorted[0]!;

    return (
      <Box paddingX={1}>
        <Text color={color("accent")}>task </Text>
        <Text wrap="truncate-end">{current.title}</Text>
        {todoCount > 0 && <Text dimColor>{` +${todoCount}`}</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      <Text bold color={color("accent")}>Tasks</Text>
      {sorted.map((task) => (
        <Box key={task.id} flexDirection="row" gap={1}>
          <Text color={statusColor(task.status)}>{statusLabel(task.status)}</Text>
          <Text wrap="truncate-end">{task.title}</Text>
        </Box>
      ))}
    </Box>
  );
}

function byPriority(a: Task, b: Task): number {
  const rank: Record<Task["status"], number> = { doing: 0, todo: 1, done: 2 };
  return rank[a.status] - rank[b.status];
}

function statusLabel(status: Task["status"]): string {
  switch (status) {
    case "done":
      return "done";
    case "doing":
      return "now ";
    case "todo":
      return "next";
  }
}

function statusColor(status: Task["status"]): string {
  switch (status) {
    case "done":
      return color("success");
    case "doing":
      return color("accent");
    case "todo":
      return color("muted");
  }
}
