import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { Task } from "../../agent/tasks.js";
import { color } from "../theme.js";

export type TaskViewProps = {
  tasks: Task[];
  compact?: boolean;
};

export function TaskView({ tasks, compact }: TaskViewProps) {
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (!tasks.some((t) => t.status === "doing")) return;
    const id = setInterval(() => setPulse((p) => !p), 600);
    return () => clearInterval(id);
  }, [tasks]);

  if (tasks.length === 0) return null;

  // Priority order: doing first, then todo, then done.
  const sorted = [...tasks].sort(byPriority);

  if (compact) {
    const doing = sorted.find((t) => t.status === "doing");
    const doneCount = tasks.filter((t) => t.status === "done").length;
    const todoCount = tasks.filter((t) => t.status === "todo").length;

    return (
      <Box paddingX={1}>
        {doing !== undefined ? (
          <Box flexDirection="row" gap={1}>
            <Text color={statusColor(doing.status, pulse)}>{statusIcon(doing.status, pulse)}</Text>
            <Text>{doing.title}</Text>
            {(doneCount > 0 || todoCount > 0) && (
              <Text dimColor>
                ({[doneCount > 0 ? `${doneCount} done` : "", todoCount > 0 ? `${todoCount} todo` : ""].filter(Boolean).join(", ")})
              </Text>
            )}
          </Box>
        ) : (
          <Box flexDirection="row" gap={1}>
            <Text color={color("success")}>●</Text>
            <Text dimColor>{tasks.length} task{tasks.length !== 1 ? "s" : ""} complete</Text>
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color={color("accent")}>
        Tasks
      </Text>
      {tasks.map((task) => (
        <Box key={task.id} flexDirection="row" gap={1}>
          <Text color={statusColor(task.status, pulse)}>
            {statusIcon(task.status, pulse)}
          </Text>
          <Text>{task.title}</Text>
        </Box>
      ))}
    </Box>
  );
}

function byPriority(a: Task, b: Task): number {
  const rank: Record<Task["status"], number> = { doing: 0, todo: 1, done: 2 };
  return rank[a.status] - rank[b.status];
}

function statusIcon(status: Task["status"], pulse: boolean): string {
  switch (status) {
    case "done":
      return "●";
    case "doing":
      return pulse ? "◎" : "◉";
    case "todo":
      return "○";
  }
}

function statusColor(status: Task["status"], pulse: boolean): string {
  switch (status) {
    case "done":
      return color("success");
    case "doing":
      return pulse ? color("warning") : color("accent");
    case "todo":
      return color("muted");
  }
}
