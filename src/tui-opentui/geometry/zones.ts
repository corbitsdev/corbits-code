// Chrome zone registry for the OpenTUI shell.
// Source of truth: docs/TUI.md "How it should look" (zone table + collapse order).
// Pure data — no process.stdout, no paint framework.

/** Constitution zone ids (snake_case matches the registry table). */
export const ZONE_IDS = [
  "progress",
  "progress_divider",
  "notice",
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

export type ZoneDeclaration = {
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
};

/**
 * Bound on rendered agent rows in the live agents panel. A large fan-out
 * degrades to a trailing "+N more" row instead of growing the zone (and
 * therefore the chrome budget) without limit.
 */
export const AGENTS_PANEL_MAX_VISIBLE = 5;

/**
 * Bound on rendered task rows in the live task-list panel. Mirrors
 * AGENTS_PANEL_MAX_VISIBLE: a large task list degrades to a trailing
 * "+N more" row instead of growing the zone without limit.
 */
export const TASKS_PANEL_MAX_VISIBLE = 5;

/**
 * Fixed-with-test budgets from the constitution table.
 * Residual zones (transcript, overlay_host) use min/max as floor/cap hints;
 * actual heights are assigned by the geometry resolver.
 */
export const ZONE_REGISTRY: { readonly [K in ZoneId]: ZoneDeclaration } = {
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
  // A leading fleet-summary row, one row per running agent (bounded by
  // AGENTS_PANEL_MAX_VISIBLE), then an optional trailing "+N more" row. All
  // three must fit: clipping the last one drops the fold-away count at exactly
  // the fan-out size where it is the only thing reporting the hidden lanes.
  agents: {
    id: "agents",
    min: 0,
    max: AGENTS_PANEL_MAX_VISIBLE + 2,
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
  // prompt growth reclaimed next (handled specially; never below PROMPT_BASE_ROWS)
  "prompt",
] as const satisfies readonly ZoneId[];

/**
 * Top-to-bottom paint order for y-stacked rects.
 * Transcript is residual in the middle; the prompt box is the last thing painted.
 */
export const PAINT_ORDER = [
  "task",
  "agents",
  "transcript",
  "overlay_host",
  "plugin_banner",
  "command_banner",
  "settings_notice",
  "progress",
  "progress_divider",
  "notice",
  "prompt",
] as const satisfies readonly ZoneId[];

export function zoneDeclaration(id: ZoneId): ZoneDeclaration {
  return ZONE_REGISTRY[id];
}
