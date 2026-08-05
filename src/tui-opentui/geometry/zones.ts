// Chrome zone registry for the OpenTUI shell.
// Source of truth: docs/tui-layout-constitution.md §3 zone table + §3.3 collapse order.
// Pure data — no process.stdout, no paint framework.

/** Constitution zone ids (snake_case matches the registry table). */
export const ZONE_IDS = [
  "header",
  "progress",
  "progress_divider",
  "model_bar",
  "prompt",
  "status",
  "goal",
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
 * Fixed-with-test budgets from the constitution table.
 * Residual zones (transcript, overlay_host) use min/max as floor/cap hints;
 * actual heights are assigned by the geometry resolver.
 */
export const ZONE_REGISTRY: { readonly [K in ZoneId]: ZoneDeclaration } = {
  header: { id: "header", min: 1, max: 2, idleDefault: 2, alwaysOn: true },
  progress: { id: "progress", min: 0, max: 2, idleDefault: 0, alwaysOn: false },
  progress_divider: {
    id: "progress_divider",
    min: 0,
    max: 1,
    idleDefault: 0,
    alwaysOn: false,
  },
  model_bar: { id: "model_bar", min: 0, max: 1, idleDefault: 1, alwaysOn: true },
  prompt: { id: "prompt", min: 3, max: 3, idleDefault: 3, alwaysOn: true },
  status: { id: "status", min: 1, max: 2, idleDefault: 2, alwaysOn: true },
  goal: { id: "goal", min: 0, max: 1, idleDefault: 0, alwaysOn: false },
  task: { id: "task", min: 0, max: 1, idleDefault: 0, alwaysOn: false },
  agents: { id: "agents", min: 0, max: 1, idleDefault: 0, alwaysOn: false },
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

/** Prompt base bordered height (borders + one content line). */
export const PROMPT_BASE_ROWS = 3;

/**
 * Collapse order when transcript would breach the floor (first cut first).
 * Matches docs/tui-layout-constitution.md §3.3.
 */
export const COLLAPSE_ORDER = [
  "command_banner",
  "settings_notice",
  "plugin_banner",
  "goal",
  "task",
  "agents",
  "progress",
  "progress_divider",
  "model_bar",
  // prompt growth reclaimed next (handled specially; never below PROMPT_BASE_ROWS)
  "prompt",
  // last resort
  "header",
  "status",
] as const satisfies readonly ZoneId[];

/**
 * Top-to-bottom paint order for y-stacked rects.
 * Transcript is residual in the middle; bottom chrome is prompt stack + status.
 */
export const PAINT_ORDER = [
  "header",
  "goal",
  "task",
  "agents",
  "transcript",
  "overlay_host",
  "plugin_banner",
  "command_banner",
  "settings_notice",
  "progress",
  "progress_divider",
  "model_bar",
  "prompt",
  "status",
] as const satisfies readonly ZoneId[];

export function zoneDeclaration(id: ZoneId): ZoneDeclaration {
  return ZONE_REGISTRY[id];
}
