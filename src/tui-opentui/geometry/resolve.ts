// Pure geometry resolver: terminal size + zone visibility + overlay mode → rects.
// Caller passes { columns, rows }; this module never reads process.stdout.

import { resolveContentWidth, resolveSideMargin } from "./margins.js";
import {
  COLLAPSE_ORDER,
  IDLE_TRANSCRIPT_FLOOR,
  OVERLAY_MAX_FRACTION,
  OVERLAY_TRANSCRIPT_FLOOR,
  PAINT_ORDER,
  PROMPT_BASE_ROWS,
  PROMPT_CAP_FRACTION,
  ZONE_REGISTRY,
  type ZoneId,
} from "./zones.js";

export type TerminalSize = {
  readonly columns: number;
  readonly rows: number;
};

export type OverlayMode = "closed" | "inset" | "full_shell";

export type OverlayInput = {
  readonly mode: OverlayMode;
  /** Requested overlay body rows (measured by host). Capped by fraction + floor. */
  readonly bodyRows?: number;
};

/**
 * Optional chrome visibility. Always-on zones (model_bar, prompt, hint) default
 * to their idle budgets when omitted. Optional zones default to off (0).
 */
export type ZoneVisibility = {
  /** Model bar on (default true → 1 row). Pass false to start collapsed. */
  readonly modelBar?: boolean;
  /** Progress: false/omit = 0; true = 2; or explicit 1|2. */
  readonly progress?: boolean | 1 | 2;
  /** Progress divider (0–1). Default on when progress is shown. */
  readonly progressDivider?: boolean;
  readonly goal?: boolean;
  readonly task?: boolean;
  readonly agents?: boolean;
  readonly pluginBanner?: boolean;
  /** Command banner: true → 1 row, or explicit 1|2. */
  readonly commandBanner?: boolean | 1 | 2;
  /** Settings notice: true → 1 row, or explicit 1–3. */
  readonly settingsNotice?: boolean | 1 | 2 | 3;
};

export type GeometryInput = {
  readonly terminal: TerminalSize;
  readonly visibility?: ZoneVisibility;
  /**
   * Requested prompt rows (content + borders). Capped at 40% of terminal rows
   * and floor-safe max. Default PROMPT_BASE_ROWS (3).
   */
  readonly promptContentRows?: number;
  readonly overlay?: OverlayInput;
};

export type Rect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type GeometryLayout = {
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
};

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
    vis.progressDivider === true
      ? 1
      : vis.progressDivider === false
        ? 0
        : progressRows > 0
          ? 1
          : 0;

  const modelBar =
    vis.modelBar === false ? 0 : ZONE_REGISTRY.model_bar.idleDefault;

  const promptRequested = input.promptContentRows ?? PROMPT_BASE_ROWS;
  const promptCap = Math.max(
    PROMPT_BASE_ROWS,
    Math.floor(rows * PROMPT_CAP_FRACTION),
  );
  const promptRows = clamp(promptRequested, PROMPT_BASE_ROWS, promptCap);

  const heights: MutableHeights = {
    progress: clamp(progressRows, 0, ZONE_REGISTRY.progress.max),
    progress_divider: progressDivider,
    model_bar: modelBar,
    prompt: promptRows,
    hint: ZONE_REGISTRY.hint.idleDefault,
    goal: vis.goal ? 1 : 0,
    task: vis.task ? 1 : 0,
    agents: vis.agents ? 1 : 0,
    plugin_banner: vis.pluginBanner ? 1 : 0,
    command_banner: clamp(
      boolOrRows(vis.commandBanner, 1),
      0,
      ZONE_REGISTRY.command_banner.max,
    ),
    settings_notice: clamp(
      boolOrRows(vis.settingsNotice, 1),
      0,
      ZONE_REGISTRY.settings_notice.max,
    ),
    transcript: 0,
    overlay_host: 0,
  };

  return heights;
}

function sumChrome(heights: MutableHeights): number {
  let total = 0;
  for (const id of PAINT_ORDER) {
    if (id === "transcript" || id === "overlay_host") continue;
    total += heights[id];
  }
  return total;
}

function transcriptFloorFor(mode: OverlayMode, terminalRows: number): number {
  if (mode === "full_shell") return 0;
  if (mode === "inset") {
    // Proposed ≥ 8 on 24-row; scale gently on shorter terminals.
    if (terminalRows < 24) return Math.min(OVERLAY_TRANSCRIPT_FLOOR, Math.max(4, terminalRows - 12));
    return OVERLAY_TRANSCRIPT_FLOOR;
  }
  // closed: hard floor 12; on tiny terminals attempt what remains after min chrome
  if (terminalRows < 24) {
    const minChrome = PROMPT_BASE_ROWS + ZONE_REGISTRY.hint.min;
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

  if (mode === "full_shell") {
    // Overlay owns residual after any remaining chrome (usually 0 after hide).
    return Math.max(0, rows - chrome);
  }

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
      // Never below base; reclaim growth only.
      if (h > PROMPT_BASE_ROWS) {
        heights.prompt = PROMPT_BASE_ROWS;
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
  const width = resolveContentWidth(terminal.columns);
  let y = 0;
  for (const id of PAINT_ORDER) {
    const height = heights[id];
    if (height <= 0) continue;
    regions[id] = {
      x,
      y,
      width,
      height,
    };
    y += height;
  }
  return regions;
}

/**
 * Resolve shell region rects from terminal size, optional chrome, and overlay mode.
 * Pure: no I/O. Extra terminal rows accrue to the transcript residual.
 */
export function resolveGeometry(input: GeometryInput): GeometryLayout {
  const terminal = {
    columns: Math.max(1, Math.floor(input.terminal.columns)),
    rows: Math.max(1, Math.floor(input.terminal.rows)),
  };
  const mode: OverlayMode = input.overlay?.mode ?? "closed";
  const floor = transcriptFloorFor(mode, terminal.rows);
  const heights = desiredHeights({ ...input, terminal });
  const collapsed: ZoneId[] = [];

  // Full-shell modal: hide transcript and bottom chrome; overlay owns residual.
  if (mode === "full_shell") {
    heights.transcript = 0;
    heights.goal = 0;
    heights.task = 0;
    heights.agents = 0;
    heights.plugin_banner = 0;
    heights.command_banner = 0;
    heights.settings_notice = 0;
    heights.progress = 0;
    heights.progress_divider = 0;
    heights.model_bar = 0;
    heights.prompt = 0;
    // The hint row survives every mode: it carries the overlay's own keys.
    const chrome = sumChrome(heights);
    heights.overlay_host = Math.max(0, terminal.rows - chrome);
    const regions = assignRects(heights, terminal);
    return {
      terminal,
      transcriptHeight: 0,
      chromeHeight: chrome,
      overlayHeight: heights.overlay_host,
      regions,
      heights,
      collapsed,
      overlayMode: mode,
      transcriptFloor: floor,
      sideMargin: resolveSideMargin(terminal.columns),
      contentWidth: resolveContentWidth(terminal.columns),
    };
  }

  // Cap prompt growth against floor before overlay allocation.
  const promptCap = Math.max(
    PROMPT_BASE_ROWS,
    Math.floor(terminal.rows * PROMPT_CAP_FRACTION),
  );
  if (heights.prompt > promptCap) heights.prompt = promptCap;

  // Iteratively collapse optional chrome until transcript meets floor with overlay.
  const maxIters = 32;
  for (let i = 0; i < maxIters; i++) {
    const chrome = sumChrome(heights);
    const overlay = desiredOverlayHeight(
      { ...input, terminal },
      mode,
      chrome,
      floor,
    );
    const transcript = terminal.rows - chrome - overlay;
    if (transcript >= floor) {
      heights.transcript = Math.max(0, transcript);
      heights.overlay_host = overlay;
      break;
    }
    // Need more space: collapse one zone, then retry.
    const cut = collapseOnce(heights, collapsed);
    if (cut === null) {
      // Nothing left — accept best effort (may be below floor on tiny terminals).
      heights.overlay_host = desiredOverlayHeight(
        { ...input, terminal },
        mode,
        chrome,
        0,
      );
      heights.transcript = Math.max(0, terminal.rows - sumChrome(heights) - heights.overlay_host);
      break;
    }
  }

  // Final consistency: residual must sum exactly to terminal.rows.
  const chromeHeight = sumChrome(heights);
  const overlayHeight = heights.overlay_host;
  heights.transcript = Math.max(0, terminal.rows - chromeHeight - overlayHeight);

  // Reclaim any rounding leftover into transcript only (never chrome).
  const assigned =
    chromeHeight + overlayHeight + heights.transcript;
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
    sideMargin: resolveSideMargin(terminal.columns),
    contentWidth: resolveContentWidth(terminal.columns),
  };
}
