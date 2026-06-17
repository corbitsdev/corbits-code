import { Box, Text } from "ink";
import type { Task } from "../../agent/tasks.js";
import { color } from "../theme.js";

export type TaskViewProps = {
  tasks: Task[];
};

export function TaskView({ tasks }: TaskViewProps) {
  if (tasks.length === 0) return null;
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color={color("accent")}>
        Tasks
      </Text>
      {tasks.map((task) => (
        <Box key={task.id} flexDirection="row" gap={1}>
          <Text color={statusColor(task.status)}>
            {statusIcon(task.status)}
          </Text>
          <Text>{task.title}</Text>
        </Box>
      ))}
    </Box>
  );
}

function statusIcon(status: Task["status"]): string {
  switch (status) {
    case "done":
      return "✓";
    case "doing":
      return "⏳";
    case "todo":
      return "○";
  }
}

function statusColor(status: Task["status"]): string {
  switch (status) {
    case "done":
      return color("success");
    case "doing":
      return color("warning");
    case "todo":
      return color("muted");
  }
}
