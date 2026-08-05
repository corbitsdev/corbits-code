import { homedir } from "node:os";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import {
  COMPACTION_WINDOW_FRACTION,
  CONTEXT_METER_DANGER_FRACTION,
} from "../../provider/context-window.js";
import { color, type SemanticRole } from "../theme.js";
import { PRODUCT_NAME } from "../../branding.js";

export type StatusBarProps = {
  // Label for completed sub-agent timing (e.g. "agents 2m 14s"). Replaces the
  // whole-session wall clock which was noise for long sessions.
  completedAgentsLabel?: string;
  mcpCount: number;
  // Pre-formatted by src/cost/cost-summary.ts; omitted entirely when cost
  // should stay hidden (free model, coding plan) rather than shown as $0.
  costLabel?: string;
  contextLabel?: string;
  // Integer 0–100 occupancy of the model window, or null when unknown.
  // Drives the context meter's normal → warning → danger color thresholds.
  contextPercentUsed?: number | null;
  model?: string;
  cwd?: string;
  gitBranch?: string | null;
  // Available terminal columns, used to drop/truncate low-priority segments
  // (model/cwd/branch, then cost/context) before running out of room.
  columns?: number;
};

// Color thresholds for the context-usage meter, tied to the same fractions
// compaction and near-overflow use: muted below compaction, warning from the
// compaction point, danger when the window is nearly full.
export type ContextMeterTone = "normal" | "warning" | "danger";

export function contextMeterTone(percentUsed: number | null | undefined): ContextMeterTone {
  if (percentUsed == null) return "normal";
  if (percentUsed >= Math.round(CONTEXT_METER_DANGER_FRACTION * 100)) return "danger";
  if (percentUsed >= Math.round(COMPACTION_WINDOW_FRACTION * 100)) return "warning";
  return "normal";
}

function contextMeterRole(tone: ContextMeterTone): SemanticRole {
  if (tone === "danger") return "danger";
  if (tone === "warning") return "warning";
  return "muted";
}

const BRAND = PRODUCT_NAME;

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
  agentsText?: string;
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
// (highest to lowest, dropped first when narrow): brand+agents > MCP >
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
      args.agentsText,
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

export { formatElapsed } from "./in-flight-indicator.js";
import { formatElapsed } from "./in-flight-indicator.js";

// Slim footer: brand anchors the bottom-left; completed sub-agent timing sits
// beside it when any worker has finished this session. MCP health sits on the
// right. The per-turn timer lives on the in-flight indicator above the prompt
// box, not here.
//
// Segment priority (highest to lowest, dropped first when the terminal is
// narrow): brand+agents > model/cwd/branch > cost/context. cwd is truncated
// with a middle ellipsis before the model/cwd/branch segment is dropped
// entirely.
export function StatusBar({
  completedAgentsLabel,
  mcpCount,
  costLabel,
  contextLabel,
  contextPercentUsed,
  model,
  cwd,
  gitBranch,
  columns,
}: StatusBarProps): ReactNode {
  const agentsText =
    completedAgentsLabel !== undefined && completedAgentsLabel.length > 0
      ? completedAgentsLabel
      : undefined;
  const mcpText = mcpCount > 0 ? `MCP ✓ ${mcpCount}` : undefined;
  const { modelCwdBranchText, showCost, showContext } = planStatusBarLayout({
    columns: columns ?? 120,
    ...(agentsText !== undefined ? { agentsText } : {}),
    ...(mcpText !== undefined ? { mcpText } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(cwd !== undefined ? { cwd: abbreviateHome(cwd) } : {}),
    ...(gitBranch != null ? { gitBranch } : {}),
    ...(costLabel !== undefined ? { costLabel } : {}),
    ...(contextLabel !== undefined ? { contextLabel } : {}),
  });
  const meterTone = contextMeterTone(contextPercentUsed);
  const meterRole = contextMeterRole(meterTone);
  // Warning/danger should read clearly; normal stays dim with the rest of the footer.
  const meterDim = meterTone === "normal";

  return (
    <Box flexDirection="row" paddingX={1} gap={1} overflow="hidden">
      <Text bold color={color("muted")} dimColor wrap="truncate-end">{BRAND}</Text>
      {agentsText !== undefined && (
        <Text color={color("muted")} dimColor>{agentsText}</Text>
      )}
      {modelCwdBranchText !== undefined && (
        <Text color={color("muted")} dimColor wrap="truncate-end">{modelCwdBranchText}</Text>
      )}
      {showCost && costLabel !== undefined && (
        <Text color={color("muted")} dimColor>{costLabel}</Text>
      )}
      {showContext && contextLabel !== undefined && (
        <Text color={color(meterRole)} dimColor={meterDim}>{contextLabel}</Text>
      )}
      <Box flexGrow={1} />
      {mcpText !== undefined && (
        <Text color={color("success")} dimColor>{mcpText}</Text>
      )}
    </Box>
  );
}

/** Sum of finished agent wall times (not multi-agent phase wall clock) as a compact status-bar label. */
export function formatCompletedAgentsLabel(
  sessions: ReadonlyArray<{ status: string; startedAt: number; finishedAt?: number }>,
): string | undefined {
  let totalMs = 0;
  let count = 0;
  for (const s of sessions) {
    if (s.status !== "done" && s.status !== "failed" && s.status !== "cancelled") continue;
    if (s.finishedAt === undefined || s.finishedAt < s.startedAt) continue;
    totalMs += s.finishedAt - s.startedAt;
    count += 1;
  }
  if (count === 0) return undefined;
  return `agents ${formatElapsed(totalMs)}`;
}
