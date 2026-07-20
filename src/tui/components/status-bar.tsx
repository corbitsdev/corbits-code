import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { color } from "../theme.js";

export type StatusBarProps = {
  // Whole-session elapsed time, always counting (not per-turn).
  sessionElapsedMs: number;
  mcpCount: number;
  // Pre-formatted by src/cost/cost-summary.ts; omitted entirely when cost
  // should stay hidden (free model, coding plan) rather than shown as $0.
  costLabel?: string;
  contextLabel?: string;
};

const BRAND = "Intercode";

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

// Slim footer: brand anchors the bottom-left with the session timer beside it;
// MCP health sits on the right. The per-turn timer lives on the in-flight
// indicator above the prompt box, not here.
export function StatusBar({ sessionElapsedMs, mcpCount, costLabel, contextLabel }: StatusBarProps): ReactNode {
  return (
    <Box flexDirection="row" paddingX={1} gap={1} overflow="hidden">
      <Text bold color={color("muted")} dimColor wrap="truncate-end">{BRAND}</Text>
      <Text color={color("muted")} dimColor>{formatElapsed(sessionElapsedMs)}</Text>
      {costLabel !== undefined && (
        <Text color={color("muted")} dimColor>{costLabel}</Text>
      )}
      {contextLabel !== undefined && (
        <Text color={color("muted")} dimColor>{contextLabel}</Text>
      )}
      <Box flexGrow={1} />
      {mcpCount > 0 && (
        <Text color={color("success")} dimColor>{`MCP ✓ ${mcpCount}`}</Text>
      )}
    </Box>
  );
}
