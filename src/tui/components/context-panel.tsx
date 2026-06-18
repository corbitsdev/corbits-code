import type { ReactNode } from "react";
import type { Task } from "../../agent/tasks.js";
import { TaskView } from "./task-view.js";

export type ContextPanelProps = {
  tasks: Task[];
  width: number;
  borderColor?: string;
};

export function ContextPanel({ tasks }: ContextPanelProps): ReactNode {
  return <TaskView tasks={tasks} />;
}
