import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";

import { TaskView } from "../../../src/tui/components/task-view.js";
import type { Task } from "../../../src/agent/tasks.js";

const tasks: Task[] = [
  { id: "doing", title: "Active task", status: "doing" },
  { id: "todo", title: "Inactive task", status: "todo" },
  { id: "done", title: "Completed task", status: "done" },
  { id: "cancelled", title: "Cancelled task", status: "cancelled" },
];

describe("TaskView", () => {
  test("renders circular task glyphs plus terminal check and cross states", () => {
    const { lastFrame } = render(<TaskView tasks={tasks} />);

    expect(lastFrame()).toContain("● Active task");
    expect(lastFrame()).toContain("○ Inactive task");
    expect(lastFrame()).toContain("✓ Completed task");
    expect(lastFrame()).toContain("✗ Cancelled task");
  });

  test("compact mode ignores terminal tasks", () => {
    const terminalTasks = tasks.filter((task) => task.status !== "doing" && task.status !== "todo");
    const { lastFrame } = render(<TaskView tasks={terminalTasks} compact />);

    expect(lastFrame()).toBe("");
  });

  test("removes the whole block when every task is terminal, in both views", () => {
    const terminalTasks: Task[] = [
      { id: "done", title: "Completed task", status: "done" },
      { id: "cancelled", title: "Cancelled task", status: "cancelled" },
    ];

    expect(render(<TaskView tasks={terminalTasks} compact />).lastFrame()).toBe("");
    expect(render(<TaskView tasks={terminalTasks} />).lastFrame()).toBe("");
  });
});
