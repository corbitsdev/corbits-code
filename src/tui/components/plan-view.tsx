import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { PlanStep } from "../use-stream.js";
import { color } from "../theme.js";

export type PlanViewProps = {
  steps: PlanStep[];
  currentPlanStep: number | null;
  planDeviated: boolean;
  width: number;
};

function formatPlanStep(step: PlanStep, index: number): string {
  const number = `${index + 1}.`;
  if (step.file.length === 0) return `${number} ${step.action}`;
  if (step.action.length === 0) return `${number} ${step.file}`;
  return `${number} ${step.file} — ${step.action}`;
}

function truncate(text: string, max: number): string {
  if (max <= 1) return text.slice(0, Math.max(0, max));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function PlanView({ steps, currentPlanStep, planDeviated, width }: PlanViewProps): ReactNode {
  const contentWidth = Math.max(8, width - 4);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color("brand")} paddingX={1} width={width} flexGrow={1}>
      <Text bold color={color("brand")}>
        Plan  {steps.length} {steps.length === 1 ? "step" : "steps"}
      </Text>
      {steps.length === 0 ? (
        <Text color={color("muted")}>No plan submitted yet.</Text>
      ) : null}
      {steps.map((step, i) => {
        const isCurrent = i === currentPlanStep;
        const isDeviation = planDeviated && i === currentPlanStep;
        const stepColor = isDeviation
          ? color("danger")
          : isCurrent
            ? color("accent")
            : color("text");
        const marker = isCurrent ? "▸ " : "  ";
        return (
          <Text key={`plan-step-${i}`} color={stepColor} bold={isCurrent}>
            {marker}
            {truncate(formatPlanStep(step, i), contentWidth - 2)}
          </Text>
        );
      })}
    </Box>
  );
}
