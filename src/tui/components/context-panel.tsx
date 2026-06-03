import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { PlanStep } from "../use-stream.js";
import { PlanView } from "./plan-view.js";
import { color } from "../theme.js";

export type ContextView = "plan" | "diff";

export type ContextPanelProps = {
  view: ContextView;
  steps: PlanStep[];
  currentPlanStep: number | null;
  planDeviated: boolean;
  width: number;
};

export function ContextPanel({ view, steps, currentPlanStep, planDeviated, width }: ContextPanelProps): ReactNode {
  if (view === "diff") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={color("muted")} paddingX={1} width={width}>
        <Text bold color={color("accent")}>Diff</Text>
        <Text color={color("muted")}>No changes yet.</Text>
      </Box>
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
