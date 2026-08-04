import { Box, Text } from "ink";
import { useEffect, useState, type ReactNode } from "react";
import {
  elapsedMsFromAnchor,
  SPINNER_FRAMES,
  spinnerFrameAt,
  SPINNER_FRAME_MS,
} from "../hooks/use-spinner.js";
import { color } from "../theme.js";

export type InlineWorkflowStatus = {
  name: string;
  stepIndex: number;
  total: number;
  label: string;
};

export type InFlightIndicatorProps = {
  active: boolean;
  /** Wall-clock anchor for cumulative elapsed; null while idle. */
  timingAnchor: number | null;
  label?: string;
  toolName?: string | null;
  workflow?: InlineWorkflowStatus;
};

// Ink draws to the terminal — there is no CSS @keyframes. This hook is the
// lightest equivalent: one small subtree repaints on SPINNER_FRAME_MS, not App.
export function useInFlightVisuals(active: boolean, timingAnchor: number | null): { frame: string; elapsedMs: number } {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), SPINNER_FRAME_MS);
    return () => clearInterval(id);
  }, [active]);
  void tick;
  const now = Date.now();
  return {
    frame: active ? spinnerFrameAt(now) : SPINNER_FRAMES[0]!,
    elapsedMs: active ? elapsedMsFromAnchor(timingAnchor, now) : 0,
  };
}

// The "still working" hint only appears once a wait runs past this, so a fast
// reply never flashes a counter — only a genuinely slow one earns the seconds.
const SLOW_THRESHOLD_MS = 2000;

export function resolveLabel(label: string | undefined): string {
  return label ?? "Thinking…";
}

export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;

  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${minutes}m ${seconds}s`;
}

/** True when the progress row has anything to paint (live phase or workflow chip). */
export function shouldShowProgressRow(input: {
  active: boolean;
  hasWorkflow: boolean;
}): boolean {
  return input.active || input.hasWorkflow;
}

// Single dim progress line for the session phase. Hidden entirely when idle
// with nothing to show — no permanent blank spacer eating chrome rows.
export function InFlightIndicator({ active, timingAnchor, label, toolName, workflow }: InFlightIndicatorProps): ReactNode {
  const { frame, elapsedMs } = useInFlightVisuals(active, timingAnchor);
  const workflowText = workflow !== undefined
    ? `⟳ ${workflow.name} · ${workflow.stepIndex + 1}/${workflow.total} ${workflow.label}`
    : undefined;

  if (!shouldShowProgressRow({ active, hasWorkflow: workflowText !== undefined })) {
    return null;
  }

  if (!active) {
    return (
      <Box paddingX={1} marginTop={1}>
        <Box flexGrow={1} justifyContent="flex-end">
          <Text color={color("accent")} dimColor>{workflowText}</Text>
        </Box>
      </Box>
    );
  }
  const suffix = elapsedMs >= SLOW_THRESHOLD_MS ? ` ${formatElapsed(elapsedMs)}` : "";
  const displayLabel = resolveLabel(label);
  const toolText = toolName === null || toolName === undefined ? "" : ` · ${toolName}`;
  return (
    <Box paddingX={1} marginTop={1}>
      <Text color={color("live")}>{frame}</Text>
      <Text color={color("muted")} dimColor>{` ${displayLabel}${toolText}${suffix}`}</Text>
      {workflowText !== undefined && (
        <Box flexGrow={1} justifyContent="flex-end">
          <Text color={color("accent")} dimColor>{workflowText}</Text>
        </Box>
      )}
    </Box>
  );
}
