import { describe, expect, test } from "bun:test";
import { Box } from "ink";
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

  test("heading keeps a space between title and progress (no Work03/11 collision)", () => {
    const many: Task[] = Array.from({ length: 11 }, (_, i) => ({
      id: `t${i}`,
      title: i === 0 ? "Code for example long step title that should not collide" : `Step ${i}`,
      // 0 doing, 1–3 done (3 done), rest todo
      status: (i === 0 ? "doing" : i <= 3 ? "done" : "todo") as Task["status"],
    }));
    const frame = render(<TaskView tasks={many} title="Work" />).lastFrame() ?? "";

    expect(frame).toContain("Work 3/11");
    expect(frame).not.toMatch(/Work3\/11/);
    expect(frame).not.toMatch(/Work03\/11/);
    // Active step stays on its own line after the heading, glyph preserved.
    expect(frame).toMatch(/Work 3\/11[\s\S]*● Code for example/);
  });

  test("long step titles truncate within a narrow container without eating the glyph", () => {
    const long: Task[] = [
      {
        id: "doing",
        title: "Implement the entire goal mode layout overflow fix with exhaustive edge cases",
        status: "doing",
      },
      { id: "todo", title: "Next", status: "todo" },
    ];
    const frame =
      render(
        <Box width={36}>
          <TaskView tasks={long} title="Work" />
        </Box>,
      ).lastFrame() ?? "";

    expect(frame).toContain("Work 0/2");
    expect(frame).toContain("●");
    // Title is truncated; full string should not appear intact on a 36-col row
    // after padding + glyph + gap.
    const lines = frame.split("\n");
    const activeLine = lines.find((l) => l.includes("●")) ?? "";
    expect(activeLine.length).toBeLessThanOrEqual(36);
    expect(activeLine.startsWith("●") || activeLine.includes("● ")).toBe(true);
  });
});
