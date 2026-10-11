// Chrome zone registry for the OpenTUI shell.
// Source of truth: docs/TUI.md "How it should look" (zone table + collapse order).
// Pure data — no process.stdout, no paint framework.

/** Constitution zone ids (snake_case matches the registry table). */
const ZONE_IDS = [
  "progress",
  "progress_divider",
  "notice",
  "pending",
  "worker_wait",
  "prompt",
  "task",
  "agents",
  "plugin_banner",
  "command_banner",
  "settings_notice",
  "transcript",
  "overlay_host",
] as const;

export type ZoneId = (typeof ZONE_IDS)[number];

export interface ZoneDeclaration {
  readonly id: ZoneId;
  /** Hard minimum rows when the zone is present. */
  readonly min: number;
  /** Hard maximum rows when the zone is present. */
  readonly max: number;
  /** Default idle rows; optional zones start at 0 (off) unless
   * visibility opts in. */
  readonly idleDefault: number;
  /** Fixed chrome that is always considered unless collapse forces shrink. */
  readonly alwaysOn: boolean;
}

/** Rendered agent rows cap in the live panel; a larger fan-out degrades
 * to a trailing "+N more" row. */
export const AGENTS_PANEL_MAX_VISIBLE = 10;

/** Max terminal share for the fleet board before lanes hide. The board
 * sizes to content; this only bounds the large fan-out. */
export const FLEET_BOARD_CAP_FRACTION = 0.62;

/** Transcript floor while a fleet runs: with two or more lanes live the
 * operator watches the fleet, not the conversation, but the floor keeps the
 * last orchestrator report readable. */
export const FLEET_TRANSCRIPT_FLOOR = 4;

/** Lanes live before the fleet floor replaces the idle one. */
export const FLEET_FLOOR_MIN_LANES = 2;

/** Rendered task rows cap in the live panel; a larger list degrades to a
 * trailing "+N more" row (mirrors AGENTS_PANEL_MAX_VISIBLE). */
export const TASKS_PANEL_MAX_VISIBLE = 5;

/** Queued steer/follow-up rows the pending column lists before folding into
 * a trailing "+N more" row. A glance at what will send, not an editor —
 * deep stacks are rarer than the room they cost. */
export const PENDING_MAX_VISIBLE = 4;

/** Row budgets from the constitution table. Residual zones (transcript,
 * overlay_host) use min/max as floor/cap hints; the resolver assigns actual
 * heights. */
export const ZONE_REGISTRY: Readonly<Record<ZoneId, ZoneDeclaration>> = {
  progress: { id: "progress", min: 0, max: 2, idleDefault: 0, alwaysOn: false },
  progress_divider: {
    id: "progress_divider",
    min: 0,
    max: 1,
    idleDefault: 0,
    alwaysOn: false,
  },
  // Transient: rows only while there is state worth a row (queue depth,
  // latched interrupt, a flash, a live turn).
  notice: { id: "notice", min: 0, max: 1, idleDefault: 0, alwaysOn: false },
  // Stack on the prompt box: one row per item, a leading "+N more" fold,
  // plus a key-guidance row; bounded by the max.
  pending: {
    id: "pending",
    min: 0,
    max: PENDING_MAX_VISIBLE + 2,
    idleDefault: 0,
    alwaysOn: false,
  },
  // WORKER WAITING strip: one row on the prompt box while a root worker is
  // parked on ask_director. Off whenever nothing is waiting.
  worker_wait: {
    id: "worker_wait",
    min: 0,
    max: 1,
    idleDefault: 0,
    alwaysOn: false,
  },
  // Grows with the draft; the resolver caps it at PROMPT_CAP_FRACTION and
  // collapses toward min when the transcript would breach its floor.
  prompt: {
    id: "prompt",
    min: 3,
    max: Number.POSITIVE_INFINITY,
    idleDefault: 5,
    alwaysOn: true,
  },
  // One row per task (bounded by TASKS_PANEL_MAX_VISIBLE) plus an optional
  // "+N more" row. Distinct from `agents`: a task is work with a status,
  // not an executor.
  task: {
    id: "task",
    min: 0,
    max: TASKS_PANEL_MAX_VISIBLE + 1,
    idleDefault: 0,
    alwaysOn: false,
  },
  // Live agents strip under the transcript (max = visible lanes + "+N more").
  // Auto-paint: formatChromeZones → formatAgentsPanel.
  agents: {
    id: "agents",
    min: 0,
    max: AGENTS_PANEL_MAX_VISIBLE + 1,
    idleDefault: 0,
    alwaysOn: false,
  },
  plugin_banner: {
    id: "plugin_banner",
    min: 0,
    max: 1,
    idleDefault: 0,
    alwaysOn: false,
  },
  command_banner: {
    id: "command_banner",
    min: 0,
    max: 2,
    idleDefault: 0,
    alwaysOn: false,
  },
  settings_notice: {
    id: "settings_notice",
    min: 0,
    max: 3,
    idleDefault: 0,
    alwaysOn: false,
  },
  // Residual — min is the hard floor on 24-row idle; max is unused (fills rest).
  transcript: {
    id: "transcript",
    min: 12,
    max: Number.POSITIVE_INFINITY,
    idleDefault: 12,
    alwaysOn: true,
  },
  overlay_host: {
    id: "overlay_host",
    min: 0,
    max: Number.POSITIVE_INFINITY,
    idleDefault: 0,
    alwaysOn: false,
  },
};

/** Idle transcript floor (rows). Applies on 24-row and taller; extra rows accrue to transcript. */
export const IDLE_TRANSCRIPT_FLOOR = 12;

/** Proposed inset-overlay transcript floor on 24-row terminals. */
export const OVERLAY_TRANSCRIPT_FLOOR = 8;

/** Prompt height may not exceed this fraction of terminal rows. */
export const PROMPT_CAP_FRACTION = 0.4;

/** Overlay host body may not exceed this fraction of terminal rows (proposed). */
export const OVERLAY_MAX_FRACTION = 0.7;

/** Smallest overlay_host an open overlay renders into: two border rows plus
 * one content row. The transcript floor must not starve a new overlay below
 * its border cost — that renders past its box; below this minimum the
 * overlay takes rows from under PROMPT_BASE_ROWS. */
export const OVERLAY_MIN_ROWS = 3;

/** Prompt floor: labelled borders + one content line. Squeezed only when the
 * terminal is too short to seat the transcript floor beside a composing
 * area. */
export const PROMPT_BASE_ROWS = 3;

/** Input rows the prompt offers at rest, before anything has been typed. */
export const PROMPT_IDLE_INPUT_ROWS = 3;

/** Rows the two labelled rules cost the prompt box. */
export const PROMPT_BORDER_ROWS = 2;

/** Prompt bordered height at rest. */
export const PROMPT_IDLE_ROWS = PROMPT_IDLE_INPUT_ROWS + PROMPT_BORDER_ROWS;

/** Collapse order when the transcript would breach its floor (first cut
 * first; see docs/TUI.md). */
export const COLLAPSE_ORDER = [
  "command_banner",
  "settings_notice",
  "plugin_banner",
  "task",
  "agents",
  "progress",
  "progress_divider",
  "notice",
  // Pending items are the operator's own queued words: cut late, after every
  // banner and strip.
  "pending",
  // A parked worker is standing state the operator cannot see anywhere else
  // once the wake turn scrolls away, so its single row is the last optional
  // cut, just ahead of prompt growth reclaim.
  "worker_wait",
  // prompt growth reclaimed next (handled specially; never below PROMPT_BASE_ROWS)
  "prompt",
] as const satisfies readonly ZoneId[];

/** Paint order for y-stacked rects: transcript residual on top, orchestration
 * chrome (agents, task) above the prompt, notice closest to it. */
export const PAINT_ORDER = [
  "transcript",
  "overlay_host",
  "agents",
  "task",
  "plugin_banner",
  "command_banner",
  "settings_notice",
  "progress",
  "progress_divider",
  "notice",
  "pending",
  "worker_wait",
  "prompt",
] as const satisfies readonly ZoneId[];

/** Gutter columns per side once the terminal can afford them. One column
 * keeps content off the frame edge — the whole job; wider reads as excess
 * air. No middle tier: a width that can spare a column gets one. */
export const SIDE_MARGIN = 1;

/** Below this width every column belongs to content: the gutter goes to zero. */
export const MARGIN_MIN_COLUMNS = 40;

/** Gutter width for a terminal of `columns` columns. */
export function resolveSideMargin(columns: number): number {
  const cols = Math.max(0, Math.floor(columns));
  return cols >= MARGIN_MIN_COLUMNS ? SIDE_MARGIN : 0;
}

/** Columns left for content after both gutters. */
export function resolveContentWidth(columns: number): number {
  const cols = Math.max(1, Math.floor(columns));
  return Math.max(1, cols - resolveSideMargin(cols) * 2);
}

/** Blank rows above the first transcript row, carved from the transcript
 * residual (never chrome) so the resolved row budget holds. */
export const TOP_PAD_ROWS = 1;

/** Below this many transcript rows the pad is not worth the row it costs. */
export const TOP_PAD_MIN_TRANSCRIPT_ROWS = 6;

/** Top pad rows affordable for a transcript of `transcriptRows` rows. */
export function resolveTopPadRows(transcriptRows: number): number {
  return transcriptRows >= TOP_PAD_MIN_TRANSCRIPT_ROWS ? TOP_PAD_ROWS : 0;
}

/** Rows below the prompt box once the terminal can afford them. One blank row
 * keeps the prompt off the last line (TOP_PAD_ROWS clears the top, SIDE_MARGIN
 * the sides); more reads as floating. */
export const BOTTOM_MARGIN_ROWS = 1;

/** Below this height the margin is not worth its row — the resolver's
 * "short terminal" line, so every yield point agrees where optional rows
 * stop. */
export const BOTTOM_MARGIN_MIN_ROWS = 24;

/** Bottom margin rows affordable for a terminal of `terminalRows` rows. */
export function resolveBottomMarginRows(terminalRows: number): number {
  return terminalRows >= BOTTOM_MARGIN_MIN_ROWS ? BOTTOM_MARGIN_ROWS : 0;
}

/** Tallest bordered box the prompt may ask for on a terminal of `rows` rows. */
export function promptBoxCapRows(terminalRows: number): number {
  const rows = Math.max(1, Math.floor(terminalRows));
  return Math.max(PROMPT_BASE_ROWS, Math.floor(rows * PROMPT_CAP_FRACTION));
}

/** Input rows to show for `visualLines` of wrapped content. */
export function promptInputRows(
  visualLines: number,
  terminalRows: number,
): number {
  const wanted = Math.max(PROMPT_IDLE_INPUT_ROWS, Math.floor(visualLines));
  const cap = promptBoxCapRows(terminalRows) - PROMPT_BORDER_ROWS;
  return Math.max(1, Math.min(wanted, cap));
}

/** Bordered box rows to request from the geometry resolver. */
export function promptBoxRows(
  visualLines: number,
  terminalRows: number,
): number {
  return promptInputRows(visualLines, terminalRows) + PROMPT_BORDER_ROWS;
}

/** True once the content no longer fits and the input is scrolling itself. */
export function promptIsScrolling(
  visualLines: number,
  terminalRows: number,
): boolean {
  return Math.floor(visualLines) > promptInputRows(visualLines, terminalRows);
}
