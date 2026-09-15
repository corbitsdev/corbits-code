// Chrome zone registry for the OpenTUI shell.
// Source of truth: docs/TUI.md "How it should look" (zone table + collapse order).
// Pure data — no process.stdout, no paint framework.

/** Constitution zone ids (snake_case matches the registry table). */
export const ZONE_IDS = [
  "progress",
  "progress_divider",
  "notice",
  "pending",
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
  /**
   * Default idle rows when the zone is on and the caller requests no override.
   * Optional zones default to 0 (off) unless visibility opts them in.
   */
  readonly idleDefault: number;
  /** Fixed chrome that is always considered unless collapse forces shrink. */
  readonly alwaysOn: boolean;
}

/**
 * Bound on rendered agent rows in the live agents panel. A large fan-out
 * degrades to a trailing "+N more" row instead of growing the zone (and
 * therefore the chrome budget) without limit.
 */
export const AGENTS_PANEL_MAX_VISIBLE = 10;

/**
 * Share of the terminal the fleet board may take before it starts hiding
 * lanes. The board is sized to its content, so a single lane costs two rows
 * and a dozen costs thirteen; this only bounds the large fan-out, and the
 * transcript keeps everything the board does not ask for.
 */
export const FLEET_BOARD_CAP_FRACTION = 0.62;

/**
 * Transcript floor while a fleet is running.
 *
 * With two or more lanes live the operator's job is watching the fleet, not
 * reading a conversation, so the transcript stops being entitled to half the
 * screen. It never disappears — this is still enough to read the last thing
 * the orchestrator said, which is how it keeps reporting and asking.
 */
export const FLEET_TRANSCRIPT_FLOOR = 4;

/** Lanes live before the fleet floor replaces the idle one. */
export const FLEET_FLOOR_MIN_LANES = 2;

/**
 * Bound on rendered task rows in the live task-list panel. Mirrors
 * AGENTS_PANEL_MAX_VISIBLE: a large task list degrades to a trailing
 * "+N more" row instead of growing the zone without limit.
 */
export const TASKS_PANEL_MAX_VISIBLE = 5;

/**
 * Queued steer/follow-up rows the pending column lists before folding into a
 * trailing "+N more" row. The column is a glance at what will send, not a
 * full editor for the queue — a deep stack is rarer than the room it costs.
 */
export const PENDING_MAX_VISIBLE = 4;

/**
 * Fixed-with-test budgets from the constitution table.
 * Residual zones (transcript, overlay_host) use min/max as floor/cap hints;
 * actual heights are assigned by the geometry resolver.
 */
export const ZONE_REGISTRY: Readonly<Record<ZoneId, ZoneDeclaration>> = {
  progress: { id: "progress", min: 0, max: 2, idleDefault: 0, alwaysOn: false },
  progress_divider: {
    id: "progress_divider",
    min: 0,
    max: 1,
    idleDefault: 0,
    alwaysOn: false,
  },
  // Transient: rows only while the shell has state worth a row (queue depth,
  // latched interrupt, a flash, a live turn). Idle it is off.
  notice: { id: "notice", min: 0, max: 1, idleDefault: 0, alwaysOn: false },
  // Queued steer/follow-up messages stacked directly on the prompt box —
  // one row per shown item, a leading "+N more" fold plus a key-guidance
  // row, bounded by the zone max.
  pending: {
    id: "pending",
    min: 0,
    max: PENDING_MAX_VISIBLE + 2,
    idleDefault: 0,
    alwaysOn: false,
  },
  // Grows with what is being composed; the resolver caps it at PROMPT_CAP_FRACTION
  // and collapses it back toward min when the transcript would breach its floor.
  prompt: {
    id: "prompt",
    min: 3,
    max: Number.POSITIVE_INFINITY,
    idleDefault: 5,
    alwaysOn: true,
  },
  // One row per task (bounded by TASKS_PANEL_MAX_VISIBLE) plus an optional
  // trailing "+N more" row. Distinct panel from `agents`: a task is a unit
  // of work with a status, not an executor.
  task: {
    id: "task",
    min: 0,
    max: TASKS_PANEL_MAX_VISIBLE + 1,
    idleDefault: 0,
    alwaysOn: false,
  },
  // Live agents strip under the transcript when present (max = visible lanes +
  // trailing "+N more"). Auto-paint comes from formatChromeZones → formatAgentsPanel.
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

/**
 * Smallest overlay_host an open overlay can render into: two border rows plus
 * one content row. The transcript floor exists to keep conversation visible,
 * but it must not starve an overlay the operator just opened below the rows
 * its own border costs — that renders past its box instead of shrinking.
 * When even this minimum cannot be granted beside the prompt floor, the
 * overlay may take rows from below PROMPT_BASE_ROWS.
 */
export const OVERLAY_MIN_ROWS = 3;

/**
 * Prompt floor: labelled borders + one content line. Only a terminal too short
 * to seat the transcript floor alongside a composing area gets squeezed here.
 */
export const PROMPT_BASE_ROWS = 3;

/** Input rows the prompt offers at rest, before anything has been typed. */
export const PROMPT_IDLE_INPUT_ROWS = 3;

/** Rows the two labelled rules cost the prompt box. */
export const PROMPT_BORDER_ROWS = 2;

/** Prompt bordered height at rest. */
export const PROMPT_IDLE_ROWS = PROMPT_IDLE_INPUT_ROWS + PROMPT_BORDER_ROWS;

/**
 * Collapse order when transcript would breach the floor (first cut first).
 * Matches docs/TUI.md "How it should look" collapse order.
 */
export const COLLAPSE_ORDER = [
  "command_banner",
  "settings_notice",
  "plugin_banner",
  "task",
  "agents",
  "progress",
  "progress_divider",
  "notice",
  // Pending items are the operator's own queued words: cut last of the
  // optionals, just ahead of prompt growth reclaim.
  "pending",
  // prompt growth reclaimed next (handled specially; never below PROMPT_BASE_ROWS)
  "prompt",
] as const satisfies readonly ZoneId[];

/**
 * Top-to-bottom paint order for y-stacked rects.
 * Transcript is residual at the top; orchestration chrome (agents, task) sits
 * at the bottom above the prompt, with notice closest to the prompt box.
 */
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
  "prompt",
] as const satisfies readonly ZoneId[];

/**
 * Optical breathing room shared by every shell surface.
 *
 * The side gutter is one number for the whole interface — transcript, prompt
 * box, model bar, hint row and overlay host all sit inside it — so the shell
 * reads as a single column of content rather than panes that happen to be
 * stacked. Top and bottom pads are carved out of the transcript residual by
 * the shell after the geometry resolver has assigned heights, so they never
 * change the resolver's row budget.
 */

/**
 * Gutter columns on each side once the terminal can afford them.
 *
 * One column at every width the gutter exists at all. A single column is
 * already enough to keep content off the frame edge, which is the whole job,
 * and a wider gutter only read as excess air on a wide pane. There is no
 * middle tier: a width that can spare a column gets one, and a width that
 * cannot gets none.
 */
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

/**
 * Blank rows above the first transcript row. Carved out of the transcript
 * residual by the shell, never out of chrome, so the resolved row budget holds.
 */
export const TOP_PAD_ROWS = 1;

/** Below this many transcript rows the pad is not worth the row it costs. */
export const TOP_PAD_MIN_TRANSCRIPT_ROWS = 6;

/** Top pad rows affordable for a transcript of `transcriptRows` rows. */
export function resolveTopPadRows(transcriptRows: number): number {
  return transcriptRows >= TOP_PAD_MIN_TRANSCRIPT_ROWS ? TOP_PAD_ROWS : 0;
}

/**
 * Rows below the prompt box once the terminal can afford them.
 *
 * One blank row keeps the prompt off the terminal's last line the same way
 * `TOP_PAD_ROWS` keeps the first transcript row off the top edge and
 * `SIDE_MARGIN` keeps content off the left and right. More than one only
 * reads as the interface floating, so there is no middle tier.
 */
export const BOTTOM_MARGIN_ROWS = 1;

/**
 * Below this terminal height the margin is not worth the row it costs — the
 * same 24-row line the resolver already treats as "short terminal" for the
 * transcript floor, so every yield point in the layout agrees on where a
 * terminal stops being able to afford anything optional.
 */
export const BOTTOM_MARGIN_MIN_ROWS = 24;

/** Bottom margin rows affordable for a terminal of `terminalRows` rows. */
export function resolveBottomMarginRows(terminalRows: number): number {
  return terminalRows >= BOTTOM_MARGIN_MIN_ROWS ? BOTTOM_MARGIN_ROWS : 0;
}

/**
 * How tall the prompt box is for what is being composed.
 *
 * Three rules, in order of precedence:
 *
 * 1. The box never shrinks below its resting size — an empty prompt still
 *    offers PROMPT_IDLE_INPUT_ROWS lines, so there is somewhere to write and so
 *    the first typed line does not sit against the animated mark in the bottom
 *    rule.
 * 2. It grows a row per visual line of content, so a longer prompt is visible
 *    while it is being written rather than scrolling under itself immediately.
 * 3. It stops at PROMPT_CAP_FRACTION of the terminal. Past that the input
 *    scrolls internally (OpenTUI's editor view follows the caret), because rows
 *    spent here come straight out of the transcript.
 *
 * The resolver has the last word on a short terminal: it collapses the box back
 * toward PROMPT_BASE_ROWS when the transcript would otherwise breach its floor.
 * Reading the transcript matters more than seeing the whole draft at once.
 *
 * Pure: line counts in, rows out. The caller measures the wrapped line count
 * (OpenTUI's editor view already does the wrapping, including surrogate pairs
 * and wide glyphs) and applies the result.
 */

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
