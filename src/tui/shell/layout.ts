/**
 * Terminal geometry: layout application, relayout, prompt-row sync, landing split.
 */
import {
  FLEET_FLOOR_MIN_LANES,
  FLEET_TRANSCRIPT_FLOOR,
  type OverlayMode,
  type ZoneVisibility,
} from "../geometry/index.js";
import { splitLandingRows, versionBadgeVisible } from "../landing.js";

import { type AppShell, shellInternals, type ShellRenderer } from "./internals.js";

export function terminalOf(
  renderer: ShellRenderer,
  override?: { readonly columns: number; readonly rows: number },
): { columns: number; rows: number } {
  if (override) {
    return {
      columns: Math.max(1, Math.floor(override.columns)),
      rows: Math.max(1, Math.floor(override.rows)),
    };
  }
  return {
    columns: Math.max(1, Math.floor(renderer.width || 80)),
    rows: Math.max(1, Math.floor(renderer.height || 24)),
  };
}

/**
 * The version row is real chrome, not a float — it holds its own reserved
 * row at the foot of the shell rather than painting into the optical bottom
 * pad (`BOTTOM_MARGIN_ROWS`), which is blank breathing room, not a content
 * slot.
 *
 * This genuinely costs the rest of the shell a row, not just the space it
 * paints in: the geometry resolver is handed `terminal.rows - 1`, so every
 * height it derives from that — including `PROMPT_CAP_FRACTION *
 * terminal.rows`, which runs before collapse and outside `COLLAPSE_ORDER` —
 * is computed one row short of the real terminal. The badge does not sit in
 * the collapse order and does not give the row back under prompt-growth
 * pressure; it is not "free" chrome, it is chrome the operator pays a row
 * for on the landing screen, same as the task or agents panel would.
 */
export function terminalForGeometry(terminal: {
  readonly columns: number;
  readonly rows: number;
}): {
  columns: number;
  rows: number;
} {
  if (!versionBadgeVisible(terminal.columns, terminal.rows)) return terminal;
  return { columns: terminal.columns, rows: Math.max(1, terminal.rows - 1) };
}

export function defaultVisibility(visibility?: ZoneVisibility): ZoneVisibility {
  return {
    notice: false,
    progress: false,
    progressDivider: false,
    // Explicit 0 rather than left undefined: task and agents are row
    // counts, and setChromeZones compares them by ===, so an undefined
    // start forces one needless relayout the first time either is compared.
    task: 0,
    agents: 0,
    ...visibility,
  };
}

/**
 * How the landing divides its rows around the prompt box.
 *
 * A floated overlay is clipped to the rows above the box so it never covers the
 * thing the operator types into. Losing the tail of a long body to that clip is
 * survivable; losing every choice is not, because then the surface cannot be
 * answered. So the box slides down just far enough to keep the overlay's full,
 * already fraction-capped height on screen, and the starters below it pay for
 * the move.
 */
export function landingSplitFor(
  landingRows: number,
  minOverlayRows: number,
  padRows: number,
): { readonly above: number; readonly below: number } {
  const even = splitLandingRows(landingRows);
  const needed = Math.min(landingRows, minOverlayRows - padRows);
  if (minOverlayRows <= 0 || even.above >= needed) return even;
  return { above: needed, below: Math.max(0, landingRows - needed) };
}

export interface RelayoutOpts {
  readonly columns?: number;
  readonly rows?: number;
  readonly visibility?: ZoneVisibility;
  readonly promptContentRows?: number;
  readonly overlayMode?: OverlayMode;
  readonly overlayBodyRows?: number;
  /**
   * Rows the open overlay cannot render without: border + title + at least
   * one content row. Below this, the box paints past whatever height it was
   * assigned instead of shrinking, so the resolver must never starve it here.
   */
  readonly overlayMinBodyRows?: number;
}

/**
 * Rows the transcript holds back once a fleet is running.
 *
 * With several lanes live the operator is managing a fleet rather than reading
 * a conversation, so the transcript gives up its idle floor to the board. It
 * keeps enough to stay a live tail — the orchestrator reporting back and asking
 * questions is still the main way the operator learns anything.
 */
export function fleetTranscriptFloor(shell: AppShell): { transcriptFloor?: number } {
  const bag = shellInternals(shell);
  if (!bag) return {};
  const lanes = bag.chrome.agents.filter((row) => row.kind === "lane").length;
  return lanes >= FLEET_FLOOR_MIN_LANES ? { transcriptFloor: FLEET_TRANSCRIPT_FLOOR } : {};
}
