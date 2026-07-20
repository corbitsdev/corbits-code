import { homedir } from "node:os";
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
  model?: string;
  cwd?: string;
  gitBranch?: string | null;
  // Available terminal columns, used to drop/truncate low-priority segments
  // (model/cwd/branch, then cost/context) before running out of room.
  columns?: number;
};

const BRAND = "Intercode";

export function abbreviateHome(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function truncateMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength || maxLength <= 1) return text.slice(0, Math.max(0, maxLength));
  const keep = maxLength - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
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

// Slim footer: brand anchors the bottom-left with the session timer beside it;
// MCP health sits on the right. The per-turn timer lives on the in-flight
// indicator above the prompt box, not here.
//
// Segment priority (highest to lowest, dropped first when the terminal is
// narrow): brand+timer > model/cwd/branch > cost/context. cwd is truncated
// with a middle ellipsis before the model/cwd/branch segment is dropped
// entirely.
export function StatusBar({
  sessionElapsedMs,
  mcpCount,
  costLabel,
  contextLabel,
  model,
  cwd,
  gitBranch,
  columns,
}: StatusBarProps): ReactNode {
  const budget = columns ?? 120;
  const timerText = formatElapsed(sessionElapsedMs);
  const mcpText = mcpCount > 0 ? `MCP ✓ ${mcpCount}` : undefined;
  const baseLength = BRAND.length + timerText.length + 2 + (mcpText !== undefined ? mcpText.length + 1 : 0);

  const cwdDisplay = cwd !== undefined ? abbreviateHome(cwd) : undefined;
  const modelParts = [model, cwdDisplay, gitBranch ?? undefined].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  let modelCwdBranchText = modelParts.length > 0 ? modelParts.join(" · ") : undefined;

  let showCost = costLabel !== undefined;
  let showContext = contextLabel !== undefined;
  const costContextLength =
    (showCost ? costLabel!.length + 1 : 0) + (showContext ? contextLabel!.length + 1 : 0);

  let remaining =
    budget - baseLength - (modelCwdBranchText !== undefined ? modelCwdBranchText.length + 1 : 0) - costContextLength;

  // Drop lowest priority first: context, then cost, then truncate (or drop)
  // the model/cwd/branch segment.
  if (remaining < 0 && showContext) {
    remaining += contextLabel!.length + 1;
    showContext = false;
  }
  if (remaining < 0 && showCost) {
    remaining += costLabel!.length + 1;
    showCost = false;
  }
  if (remaining < 0 && modelCwdBranchText !== undefined) {
    const available = modelCwdBranchText.length + remaining;
    if (available > 3) {
      modelCwdBranchText = truncateMiddle(modelCwdBranchText, available);
    } else {
      modelCwdBranchText = undefined;
    }
  }

  return (
    <Box flexDirection="row" paddingX={1} gap={1} overflow="hidden">
      <Text bold color={color("muted")} dimColor wrap="truncate-end">{BRAND}</Text>
      <Text color={color("muted")} dimColor>{timerText}</Text>
      {modelCwdBranchText !== undefined && (
        <Text color={color("muted")} dimColor wrap="truncate-end">{modelCwdBranchText}</Text>
      )}
      {showCost && costLabel !== undefined && (
        <Text color={color("muted")} dimColor>{costLabel}</Text>
      )}
      {showContext && contextLabel !== undefined && (
        <Text color={color("muted")} dimColor>{contextLabel}</Text>
      )}
      <Box flexGrow={1} />
      {mcpText !== undefined && (
        <Text color={color("success")} dimColor>{mcpText}</Text>
      )}
    </Box>
  );
}
