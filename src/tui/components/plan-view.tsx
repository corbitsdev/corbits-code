import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { PlanStep } from "../use-stream.js";
import { color } from "../theme.js";

export type PlanViewProps = {
  goal?: string;
  steps: PlanStep[];
  currentPlanStep: number | null;
  planDeviated: boolean;
  width: number;
  borderColor?: string;
};

function wrap(text: string, max: number, indent: number): string[] {
  if (max <= 1) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  const pad = " ".repeat(indent);
  for (const word of words) {
    const limit = lines.length === 0 ? max : max - indent;
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= limit) {
      line += " " + word;
    } else {
      lines.push(line);
      line = pad + word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

export function PlanView({ goal, steps, currentPlanStep, planDeviated, width, borderColor = color("brand") }: PlanViewProps): ReactNode {
  const contentWidth = Math.max(8, width - 4);
  const done = currentPlanStep !== null ? currentPlanStep : 0;
  const total = steps.length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} width={width} flexGrow={1}>
      <Box flexDirection="row" gap={1}>
        <Text bold color={borderColor}>Plan</Text>
        {total > 0 && (
          <Text color={color("muted")}>{done}/{total}</Text>
        )}
      </Box>
      {goal !== undefined && (
        <Text color={color("muted")} italic>{goal}</Text>
      )}
      {total === 0 ? (
        <Text color={color("muted")}>Waiting for agent to submit a plan…</Text>
      ) : null}
      {steps.map((step, i) => {
        const isCurrent = i === currentPlanStep;
        const isDone = currentPlanStep !== null && i < currentPlanStep;
        const isDeviation = planDeviated && isCurrent;
        const stepColor = isDeviation
          ? color("danger")
          : isCurrent
            ? borderColor
            : isDone
              ? color("muted")
              : color("text");
        const marker = isDeviation ? "✗" : isDone ? "✓" : isCurrent ? "▸" : `${i + 1}.`;
        const fileLabel = step.file.length > 0 ? step.file : null;
        const actionLines = step.action.length > 0
          ? wrap(step.action, contentWidth - 4, 3)
          : [];
        const reasonLines = step.reason.length > 0 && isCurrent
          ? wrap(`why: ${step.reason}`, contentWidth - 4, 6)
          : [];

        return (
          <Box key={`plan-step-${i}`} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
            <Box flexDirection="row" gap={1}>
              <Text color={stepColor} bold={isCurrent}>{marker}</Text>
              {fileLabel !== null && (
                <Text color={isCurrent ? borderColor : stepColor} bold={isCurrent}>{fileLabel}</Text>
              )}
            </Box>
            {actionLines.map((line, j) => (
              <Text key={`action-${i}-${j}`} color={stepColor}>{line}</Text>
            ))}
            {reasonLines.map((line, j) => (
              <Text key={`reason-${i}-${j}`} color={color("muted")} italic>{line}</Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
