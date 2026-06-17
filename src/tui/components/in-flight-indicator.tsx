import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { color } from "../theme.js";

export type InlineWorkflowStatus = {
  name: string;
  stepIndex: number;
  total: number;
  label: string;
};

export type InFlightIndicatorProps = {
  active: boolean;
  frame: string;
  elapsedMs: number;
  label?: string;
  workflow?: InlineWorkflowStatus;
};

// The "still working" hint only appears once a wait runs past this, so a fast
// reply never flashes a counter — only a genuinely slow one earns the seconds.
const SLOW_THRESHOLD_MS = 2000;

export function resolveLabel(label: string | undefined): string {
  return label ?? "Thinking…";
}

// A single dim line that spins while the model is composing and clears the
// instant its first token streams. The row is always rendered (blank when
// idle) so the surrounding layout never shifts as it appears and disappears.
export function InFlightIndicator({ active, frame, elapsedMs, label, workflow }: InFlightIndicatorProps): ReactNode {
  const workflowText = workflow !== undefined
    ? `⟳ ${workflow.name} · ${workflow.stepIndex + 1}/${workflow.total} ${workflow.label}`
    : undefined;

  if (!active) {
    return (
      <Box paddingX={1}>
        <Text> </Text>
        {workflowText !== undefined && (
          <Box flexGrow={1} justifyContent="flex-end">
            <Text color={color("accent")} dimColor>{workflowText}</Text>
          </Box>
        )}
      </Box>
    );
  }
  const seconds = Math.floor(elapsedMs / 1000);
  const suffix = elapsedMs >= SLOW_THRESHOLD_MS ? ` ${seconds}s` : "";
  const displayLabel = resolveLabel(label);
  return (
    <Box paddingX={1}>
      <Text color={color("live")}>{frame}</Text>
      <Text color={color("muted")} dimColor>{` ${displayLabel}${suffix}`}</Text>
      {workflowText !== undefined && (
        <Box flexGrow={1} justifyContent="flex-end">
          <Text color={color("accent")} dimColor>{workflowText}</Text>
        </Box>
      )}
    </Box>
  );
}
