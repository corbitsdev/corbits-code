import type { ReactNode } from "react";
import type { Task } from "../../agent/tasks.js";
import type { DiffResult } from "../git-diff.js";
import { TaskView } from "./task-view.js";
import { DiffView } from "./diff-view.js";

export type ContextView = "tasks" | "diff";

export type ContextPanelProps = {
  view: ContextView;
  tasks: Task[];
  width: number;
  diffResult: DiffResult | null;
  diffScrollOffset: number;
  diffVisibleRows: number;
  borderColor?: string;
};

export function ContextPanel({
  view,
  tasks,
  width,
  diffResult,
  diffScrollOffset,
  diffVisibleRows,
  borderColor,
}: ContextPanelProps): ReactNode {
  if (view === "diff") {
    return (
      <DiffView
        result={diffResult}
        scrollOffset={diffScrollOffset}
        visibleRows={diffVisibleRows}
        width={width}
      />
    );
  }

  return (
    <TaskView
      tasks={tasks}
    />
  );
}
