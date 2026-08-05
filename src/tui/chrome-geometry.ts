import { goalShowsAcceptancePanel, goalShowsWorkPrimary } from "../agent/goal.js";
import { extraPromptChromeRows } from "./prompt-layout.js";
import type { PluginsAdmin } from "./components/plugins-manager.js";

export type GoalChromeArgs = {
  goalSnapshot: import("../agent/goal.js").GoalSnapshot | null;
};

export type GoalChromeResult = {
  goalActive: boolean;
  goalPhase: import("../agent/goal.js").GoalPhase | null;
  showAcceptance: boolean;
  workPrimary: boolean;
};

/** Goal chrome follows lifecycle phase: planning / reviewing / completed →
 * Acceptance panel; implementing → Work primary (Acceptance compact; header
 * shows phase). */
export function resolveGoalChrome({ goalSnapshot }: GoalChromeArgs): GoalChromeResult {
  const goalActive =
    goalSnapshot !== null &&
    goalSnapshot.status !== "inactive" &&
    goalSnapshot.status !== "cleared";
  const goalPhase = goalActive ? goalSnapshot!.phase : null;
  return {
    goalActive,
    goalPhase,
    showAcceptance: goalPhase !== null && goalShowsAcceptancePanel(goalPhase),
    workPrimary: goalPhase !== null && goalShowsWorkPrimary(goalPhase),
  };
}

export function goalChromeRowCount(args: {
  goalActive: boolean;
  showAcceptance: boolean;
  criteriaCount: number;
}): number {
  const { goalActive, showAcceptance, criteriaCount } = args;
  if (!goalActive) return 0;
  // compact phase strip during implementing
  if (!showAcceptance) return 3;
  return (criteriaCount === 0 ? 2 : criteriaCount + 2) + 2;
}

// The task strip renders above the in-flight indicator: one line when compact,
// the full checklist plus its heading when expanded. +1 is the marginTop wrapper.
export function taskChromeRowCount(args: {
  hasActiveTasks: boolean;
  taskCount: number;
  workExpanded: boolean;
}): number {
  const { hasActiveTasks, taskCount, workExpanded } = args;
  if (!hasActiveTasks) return 0;
  return (workExpanded ? taskCount + 1 : 1) + 1;
}

// The plugins overlay renders outside the modal-stack accounting (like the
// permissions overlay), so reserve rows for its box: chrome + one row per
// plugin + the selected plugin's credential rows.
export function pluginChromeRowCount(args: {
  pluginsOpen: boolean;
  pluginsAdmin: PluginsAdmin | undefined;
}): number {
  const { pluginsOpen, pluginsAdmin } = args;
  if (!pluginsOpen || pluginsAdmin === undefined) return 0;
  const list = pluginsAdmin.list();
  const widestCreds = list.reduce((n, p) => Math.max(n, p.credentials.length), 0);
  return 6 + list.length + widestCreds + 2;
}

/**
 * Rows for the settings diagnostics banner: each diagnostic is two lines
 * (`Settings warning: …` + `  Fix: …`) plus one Esc-dismiss hint. Pass 0 when
 * the banner is absent or dismissed.
 */
export function settingsNoticeRowCount(diagnosticCount: number): number {
  if (diagnosticCount <= 0) return 0;
  return diagnosticCount * 2 + 1;
}

export function extraChromeRowCount(args: {
  mcpNeedsAuthCount: number;
  /** Rows reserved for the command feedback banner (0 when absent). */
  commandMessageRows: number;
  /** Multi-line settings banner rows (0 when dismissed). Prefer settingsNoticeRowCount. */
  settingsNoticeRows?: number;
  goalChromeRows: number;
  taskChromeRows: number;
  pluginChromeRows: number;
  quotaErrorPresent: boolean;
  inferenceRetryPresent: boolean;
  subAgentChromeRows: number;
  /** Progress phase row when live or showing a workflow chip; 0 when hidden. */
  progressChromeRows: number;
  inputValue: string;
  columns: number | undefined;
  rows: number | undefined;
}): number {
  return (
    (args.mcpNeedsAuthCount > 0 ? 1 : 0) +
    args.commandMessageRows +
    (args.settingsNoticeRows ?? 0) +
    args.goalChromeRows +
    args.taskChromeRows +
    args.pluginChromeRows +
    (args.quotaErrorPresent ? 1 : 0) +
    (args.inferenceRetryPresent ? 1 : 0) +
    args.subAgentChromeRows +
    args.progressChromeRows +
    extraPromptChromeRows(args.inputValue, args.columns ?? 80, args.rows ?? 24)
  );
}

