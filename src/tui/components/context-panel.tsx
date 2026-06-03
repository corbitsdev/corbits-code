import type { ReactNode } from "react";
import type { PlanStep } from "../use-stream.js";
import type { DiffResult } from "../git-diff.js";
import { PlanView } from "./plan-view.js";
import { DiffView } from "./diff-view.js";

export type ContextView = "plan" | "diff";

export type ContextPanelProps = {
  view: ContextView;
  steps: PlanStep[];
  currentPlanStep: number | null;
  planDeviated: boolean;
  width: number;
  diffResult: DiffResult | null;
  diffScrollOffset: number;
  diffVisibleRows: number;
};

export function ContextPanel({
  view,
  steps,
  currentPlanStep,
  planDeviated,
  width,
  diffResult,
  diffScrollOffset,
  diffVisibleRows,
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
    <PlanView
      steps={steps}
      currentPlanStep={currentPlanStep}
      planDeviated={planDeviated}
      width={width}
    />
  );
}
