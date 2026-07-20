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

export function truncateMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength || maxLength <= 1) return text.slice(0, Math.max(0, maxLength));
  const keep = maxLength - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

// Width model for the status bar's Ink layout (Box paddingX={1} gap={1}):
// two columns of horizontal padding, plus one gap column between each pair
// of adjacent children — including the zero-width flex spacer that pushes
// the MCP segment to the right. Segment text is assumed to occupy one
// terminal column per character; every segment rendered here is ASCII plus
// single-width glyphs ("·", "…", "✓"). Keep this in sync with the JSX below.
const PADDING_COLUMNS = 2;
const GAP_COLUMNS = 1;
const SEPARATOR = " · ";
// Below this many columns a middle-truncated cwd is all ellipsis and noise;
// drop the whole model/cwd/branch segment instead.
const MIN_TRUNCATED_CWD = 5;

export type StatusBarLayoutArgs = {
  columns: number;
  timerText: string;
  mcpText?: string;
  model?: string;
  // Already home-abbreviated.
  cwd?: string;
  gitBranch?: string;
  costLabel?: string;
  contextLabel?: string;
};

export type StatusBarLayout = {
  modelCwdBranchText?: string;
  showCost: boolean;
  showContext: boolean;
};

function usedColumns(segments: (string | undefined)[]): number {
  const visible = segments.filter((s): s is string => s !== undefined);
  const flexSpacer = 1;
  const gapCount = visible.length + flexSpacer - 1;
  const textColumns = visible.reduce((total, s) => total + s.length, 0);
  return PADDING_COLUMNS + textColumns + GAP_COLUMNS * gapCount;
}

function joinModelCwdBranch(model?: string, cwd?: string, gitBranch?: string): string | undefined {
  const parts = [model, cwd, gitBranch].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  return parts.length > 0 ? parts.join(SEPARATOR) : undefined;
}

// Decides which low-priority segments fit in the terminal width. Priority
// (highest to lowest, dropped first when narrow): brand+timer > MCP >
// model/cwd/branch > cost > context. Only the cwd part is truncated — model
// and branch names stay intact; if the cwd cannot absorb the overflow the
// whole model/cwd/branch segment is dropped.
export function planStatusBarLayout(args: StatusBarLayoutArgs): StatusBarLayout {
  let cwd = args.cwd;
  let segment = joinModelCwdBranch(args.model, cwd, args.gitBranch);
  let showCost = args.costLabel !== undefined;
  let showContext = args.contextLabel !== undefined;

  const overflow = () =>
    usedColumns([
      BRAND,
      args.timerText,
      segment,
      showCost ? args.costLabel : undefined,
      showContext ? args.contextLabel : undefined,
      args.mcpText,
    ]) - args.columns;

  if (overflow() > 0 && showContext) showContext = false;
  if (overflow() > 0 && showCost) showCost = false;
  if (overflow() > 0 && segment !== undefined) {
    const cwdBudget = cwd !== undefined ? cwd.length - overflow() : 0;
    if (cwd !== undefined && cwdBudget >= MIN_TRUNCATED_CWD) {
      cwd = truncateMiddle(cwd, cwdBudget);
      segment = joinModelCwdBranch(args.model, cwd, args.gitBranch);
    } else {
      segment = undefined;
    }
  }

  return {
    ...(segment !== undefined ? { modelCwdBranchText: segment } : {}),
    showCost,
    showContext,
  };
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
  const timerText = formatElapsed(sessionElapsedMs);
  const mcpText = mcpCount > 0 ? `MCP ✓ ${mcpCount}` : undefined;
  const { modelCwdBranchText, showCost, showContext } = planStatusBarLayout({
    columns: columns ?? 120,
    timerText,
    ...(mcpText !== undefined ? { mcpText } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(cwd !== undefined ? { cwd: abbreviateHome(cwd) } : {}),
    ...(gitBranch != null ? { gitBranch } : {}),
    ...(costLabel !== undefined ? { costLabel } : {}),
    ...(contextLabel !== undefined ? { contextLabel } : {}),
  });

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
