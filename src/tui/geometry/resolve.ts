// Pure geometry resolver: terminal size + zone visibility + overlay mode → rects.
// Caller passes { columns, rows }; this module never reads process.stdout.

import { resolveContentWidth, resolveSideMargin } from "./margins.js";
import {
  COLLAPSE_ORDER,
  FLEET_BOARD_CAP_FRACTION,
  IDLE_TRANSCRIPT_FLOOR,
  OVERLAY_MAX_FRACTION,
  OVERLAY_MIN_ROWS,
  OVERLAY_TRANSCRIPT_FLOOR,
  PAINT_ORDER,
  PROMPT_BASE_ROWS,
  PROMPT_CAP_FRACTION,
  PROMPT_IDLE_ROWS,
  ZONE_REGISTRY,
  type ZoneId,
} from "./zones.js";

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export type OverlayMode = "closed" | "inset";

export interface OverlayInput {
  readonly mode: OverlayMode;
  /** Requested overlay body rows (measured by host). Capped by fraction + floor. */
  readonly bodyRows?: number;
  /**
   * Rows the overlay's own chrome cannot render without (border + title +
   * at least one content row). Falls back to `OVERLAY_MIN_ROWS` when the
   * caller has not measured its actual chrome.
   */
  readonly minBodyRows?: number;
}

/**
 * Optional chrome visibility. The prompt box is the only always-on zone and
 * defaults to its idle budget. Optional zones default to off (0).
 */
export interface ZoneVisibility {
  /** Transient notice row on (default off). */
  readonly notice?: boolean;
  /** Progress: false/omit = 0; true = 2; or explicit 1|2. */
  readonly progress?: boolean | 1 | 2;
  /** Progress divider (0–1). Default on when progress is shown. */
  readonly progressDivider?: boolean;
  /** Task panel: false/omit = 0 rows; true = 1 row; or an exact row count (bounded by the zone max). */
  readonly task?: boolean | number;
  /** Agents panel: false/omit = 0 rows; true = 1 row; or an exact row count (bounded by the zone max). */
  readonly agents?: boolean | number;
  readonly pluginBanner?: boolean;
  /** Command banner: true → 1 row, or explicit 1|2. */
  readonly commandBanner?: boolean | 1 | 2;
  /** Settings notice: true → 1 row, or explicit 1–3. */
  readonly settingsNotice?: boolean | 1 | 2 | 3;
}

export interface GeometryInput {
  readonly terminal: TerminalSize;
  readonly visibility?: ZoneVisibility;
  /**
   * Requested prompt rows (content + borders). Capped at 40% of terminal rows
   * and floor-safe max. Default PROMPT_IDLE_ROWS (5).
   */
  readonly promptContentRows?: number;
  readonly overlay?: OverlayInput;
  /**
   * Transcript rows to hold back for content, when the caller knows better than
   * the registry default. The landing screen passes 0: there is no transcript
   * yet, so reserving rows for one only starves whatever is on screen.
   */
  readonly transcriptFloor?: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Full-width y-stack only. Kept for API stability with shell callers. */
export type LayoutMode = "stack";

export interface GeometryLayout {
  readonly terminal: TerminalSize;
  readonly transcriptHeight: number;
  readonly chromeHeight: number;
  readonly overlayHeight: number;
  /** Region rects for every zone with height > 0 (and transcript even if 0). */
  readonly regions: Readonly<Partial<Record<ZoneId, Rect>>>;
  /** Assigned height per zone after collapse (0 = hidden). */
  readonly heights: Readonly<Record<ZoneId, number>>;
  /** Zones reduced or zeroed by collapse rules (in order applied). */
  readonly collapsed: readonly ZoneId[];
  readonly overlayMode: OverlayMode;
  /** Transcript floor applied for this resolution. */
  readonly transcriptFloor: number;
  /** Gutter columns held on each side of every zone. */
  readonly sideMargin: number;
  /** Zone width after both gutters. */
  readonly contentWidth: number;
  /** Always `"stack"` — dual-column rail was removed. */
  readonly layoutMode: LayoutMode;
  /** Transcript / chat column width. Equals contentWidth. */
  readonly chatWidth: number;
  /** Always 0 — no fleet rail. */
  readonly railWidth: number;
  /** Always 0 — no fleet rail gutter. */
  readonly railGutter: number;
}

type MutableHeights = Record<ZoneId, number>;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function boolOrRows(value: boolean | number | undefined, onRows: number): number {
  if (value === undefined || value === false) return 0;
  if (value === true) return onRows;
  return value;
}

/** Build initial desired heights from visibility + registry idle defaults. */
export function desiredHeights(input: GeometryInput): MutableHeights {
  const vis = input.visibility ?? {};
  const rows = input.terminal.rows;

  const progressRows = boolOrRows(vis.progress, 2);
  const progressDivider =
    vis.progressDivider === true ? 1 : vis.progressDivider === false ? 0 : progressRows > 0 ? 1 : 0;

  const promptRequested = input.promptContentRows ?? PROMPT_IDLE_ROWS;
  const promptCap = Math.max(PROMPT_BASE_ROWS, Math.floor(rows * PROMPT_CAP_FRACTION));
  const promptRows = clamp(promptRequested, PROMPT_BASE_ROWS, promptCap);

  const heights: MutableHeights = {
    progress: clamp(progressRows, 0, ZONE_REGISTRY.progress.max),
    progress_divider: progressDivider,
    notice: vis.notice === true ? 1 : ZONE_REGISTRY.notice.idleDefault,
    prompt: promptRows,
    task: clamp(boolOrRows(vis.task, 1), 0, ZONE_REGISTRY.task.max),
    // The board asks for exactly the rows it will paint; the fraction is what
    // stops a large fan-out from taking the screen, and it has to be computed
    // here because the registry max cannot know the terminal's height.
    agents: clamp(
      boolOrRows(vis.agents, 1),
      0,
      Math.min(ZONE_REGISTRY.agents.max, Math.max(1, Math.floor(rows * FLEET_BOARD_CAP_FRACTION))),
    ),
    plugin_banner: vis.pluginBanner ? 1 : 0,
    command_banner: clamp(boolOrRows(vis.commandBanner, 1), 0, ZONE_REGISTRY.command_banner.max),
    settings_notice: clamp(boolOrRows(vis.settingsNotice, 1), 0, ZONE_REGISTRY.settings_notice.max),
    transcript: 0,
    overlay_host: 0,
  };

  return heights;
}

/** Vertical chrome budget: every non-residual zone. */
function sumChrome(heights: MutableHeights): number {
  let total = 0;
  for (const id of PAINT_ORDER) {
    if (id === "transcript" || id === "overlay_host") continue;
    total += heights[id];
  }
  return total;
}

function transcriptFloorFor(mode: OverlayMode, terminalRows: number): number {
  if (mode === "inset") {
    // Proposed ≥ 8 on 24-row; scale gently on shorter terminals.
    if (terminalRows < 24)
      return Math.min(OVERLAY_TRANSCRIPT_FLOOR, Math.max(4, terminalRows - 12));
    return OVERLAY_TRANSCRIPT_FLOOR;
  }
  // closed: hard floor 12; on tiny terminals attempt what remains after min chrome
  if (terminalRows < 24) {
    const minChrome = PROMPT_BASE_ROWS;
    return Math.max(6, Math.min(IDLE_TRANSCRIPT_FLOOR, terminalRows - minChrome));
  }
  return IDLE_TRANSCRIPT_FLOOR;
}

function desiredOverlayHeight(
  input: GeometryInput,
  mode: OverlayMode,
  chrome: number,
  floor: number,
): number {
  if (mode === "closed") return 0;
  const rows = input.terminal.rows;
  const requested = input.overlay?.bodyRows ?? Math.floor(rows * 0.4);
  const fracCap = Math.floor(rows * OVERLAY_MAX_FRACTION);

  // inset: leave transcript floor; never exceed fraction cap
  const floorSafe = Math.max(0, rows - chrome - floor);
  return clamp(requested, 0, Math.min(fracCap, floorSafe));
}

/**
 * One collapse step: reduce the next collapsible zone.
 * Returns the zone id that was reduced, or null if nothing left to cut.
 */
function collapseOnce(heights: MutableHeights, collapsed: ZoneId[]): ZoneId | null {
  for (const id of COLLAPSE_ORDER) {
    const h = heights[id];
    if (h <= 0) continue;

    if (id === "prompt") {
      // Never below base, and one row at a time: a one-row shortfall should not
      // cost the operator the whole composing area.
      if (h > PROMPT_BASE_ROWS) {
        heights.prompt = h - 1;
        if (!collapsed.includes("prompt")) collapsed.push("prompt");
        return "prompt";
      }
      continue;
    }

    if (id === "progress") {
      // Prefer 1 row over 2 before dropping to 0.
      if (h > 1) {
        heights.progress = 1;
        if (!collapsed.includes("progress")) collapsed.push("progress");
        return "progress";
      }
      heights.progress = 0;
      if (!collapsed.includes("progress")) collapsed.push("progress");
      return "progress";
    }

    if (id === "task") {
      // Shrink one row at a time rather than zeroing in one step, same
      // rationale as "agents" below: a 1-row panel still carries the first
      // task plus a "+N more" trailer, so it stays meaningful all the way
      // down instead of vanishing under exactly the pressure an operator
      // most needs to see it. This is also what keeps the task panel
      // degrading before the prompt box: it sits ahead of "agents" and
      // every other optional zone in COLLAPSE_ORDER.
      if (h > 1) {
        heights.task = h - 1;
        if (!collapsed.includes("task")) collapsed.push("task");
        return "task";
      }
      heights.task = 0;
      if (!collapsed.includes("task")) collapsed.push("task");
      return "task";
    }

    if (id === "agents") {
      // Shrink one row at a time rather than zeroing in one step: a 1-row
      // panel still carries the stalest agent plus a "+N more" trailer
      // (formatAgentsPanel's selection sort guarantees that ordering), so
      // it stays meaningful all the way down instead of the zone vanishing
      // under exactly the pressure an operator most needs to see it.
      if (h > 1) {
        heights.agents = h - 1;
        if (!collapsed.includes("agents")) collapsed.push("agents");
        return "agents";
      }
      heights.agents = 0;
      if (!collapsed.includes("agents")) collapsed.push("agents");
      return "agents";
    }

    // Drop optional / shrinkable to 0.
    heights[id] = 0;
    if (!collapsed.includes(id)) collapsed.push(id);
    return id;
  }
  return null;
}

function assignRects(
  heights: MutableHeights,
  terminal: TerminalSize,
): Partial<Record<ZoneId, Rect>> {
  const regions: Partial<Record<ZoneId, Rect>> = {};
  const x = resolveSideMargin(terminal.columns);
  const contentWidth = resolveContentWidth(terminal.columns);
  let y = 0;
  for (const id of PAINT_ORDER) {
    const height = heights[id];
    if (height <= 0) continue;
    regions[id] = {
      x,
      y,
      width: contentWidth,
      height,
    };
    y += height;
  }
  return regions;
}

/**
 * Resolve shell region rects from terminal size, optional chrome, and overlay mode.
 * Pure: no I/O. Extra terminal rows accrue to the transcript residual.
 * Layout is always a full-width y-stack (`layoutMode: "stack"`).
 */
export function resolveGeometry(input: GeometryInput): GeometryLayout {
  const terminal = {
    columns: Math.max(1, Math.floor(input.terminal.columns)),
    rows: Math.max(1, Math.floor(input.terminal.rows)),
  };
  const mode: OverlayMode = input.overlay?.mode ?? "closed";
  const floor =
    input.transcriptFloor === undefined
      ? transcriptFloorFor(mode, terminal.rows)
      : Math.max(0, Math.floor(input.transcriptFloor));
  const heights = desiredHeights({ ...input, terminal });
  const collapsed: ZoneId[] = [];
  const contentWidth = resolveContentWidth(terminal.columns);
  const sideMargin = resolveSideMargin(terminal.columns);
  const layoutMode: LayoutMode = "stack";

  // Cap prompt growth against floor before overlay allocation.
  const promptCap = Math.max(PROMPT_BASE_ROWS, Math.floor(terminal.rows * PROMPT_CAP_FRACTION));
  if (heights.prompt > promptCap) heights.prompt = promptCap;

  // An open overlay with real content needs its own border/title rows or it
  // renders past whatever height it was actually assigned. The transcript
  // floor below cannot be satisfied at that overlay's expense.
  const requestedOverlayRows = input.overlay?.bodyRows ?? 0;
  const minOverlay =
    mode !== "closed" && requestedOverlayRows > 0
      ? Math.min(input.overlay?.minBodyRows ?? OVERLAY_MIN_ROWS, requestedOverlayRows)
      : 0;

  // Iteratively collapse optional chrome until transcript meets floor with overlay.
  // Enough steps to walk a grown prompt back to base one row at a time on top
  // of dropping every optional zone.
  const maxIters = 128;
  for (let i = 0; i < maxIters; i++) {
    const chrome = sumChrome(heights);
    const overlay = desiredOverlayHeight({ ...input, terminal }, mode, chrome, floor);
    const transcript = terminal.rows - chrome - overlay;
    if (transcript >= floor && overlay >= minOverlay) {
      heights.transcript = Math.max(0, transcript);
      heights.overlay_host = overlay;
      break;
    }
    // Need more space: collapse one zone, then retry.
    const cut = collapseOnce(heights, collapsed);
    if (cut === null) {
      // Nothing left — relax the transcript floor rather than leave the
      // overlay under its own render minimum; accept best effort past that.
      heights.overlay_host = desiredOverlayHeight({ ...input, terminal }, mode, chrome, 0);
      heights.transcript = Math.max(0, terminal.rows - sumChrome(heights) - heights.overlay_host);
      break;
    }
  }

  // Final consistency: residual must sum exactly to terminal.rows.
  const chromeHeight = sumChrome(heights);
  const overlayHeight = heights.overlay_host;
  heights.transcript = Math.max(0, terminal.rows - chromeHeight - overlayHeight);

  // Reclaim any rounding leftover into transcript only (never chrome).
  const assigned = chromeHeight + overlayHeight + heights.transcript;
  if (assigned < terminal.rows) {
    heights.transcript += terminal.rows - assigned;
  }

  const regions = assignRects(heights, terminal);

  return {
    terminal,
    transcriptHeight: heights.transcript,
    chromeHeight,
    overlayHeight,
    regions,
    heights,
    collapsed,
    overlayMode: mode,
    transcriptFloor: floor,
    sideMargin,
    contentWidth,
    layoutMode,
    chatWidth: contentWidth,
    railWidth: 0,
    railGutter: 0,
  };
}
