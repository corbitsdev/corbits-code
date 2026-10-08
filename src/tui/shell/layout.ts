/**
 * Terminal geometry: layout application, relayout, prompt-row sync, landing
 * split.
 */
import {
  FLEET_FLOOR_MIN_LANES,
  FLEET_TRANSCRIPT_FLOOR,
  type OverlayMode,
  type ZoneVisibility,
} from "../geometry/index.js";
import { splitLandingRows, versionBadgeVisible } from "../landing.js";

import {
  type AppShell,
  shellInternals,
  type ShellRenderer,
} from "./internals.js";

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
 * The version row reserves a real foot row instead of painting into the
 * optical bottom pad (`BOTTOM_MARGIN_ROWS`, blank breathing room, not a
 * content slot). So the resolver is handed `terminal.rows - 1`, and every
 * height it derives — including `PROMPT_CAP_FRACTION * terminal.rows`,
 * which runs before collapse and outside `COLLAPSE_ORDER` — is one row
 * short of the real terminal. The badge never gives that row back under
 * prompt-growth pressure (it is not in `COLLAPSE_ORDER`).
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
    // Explicit 0 rather than undefined: task and agents are row counts, and
    // setChromeZones compares by ===, so undefined forces one needless
    // relayout the first time either is compared.
    task: 0,
    agents: 0,
    ...visibility,
  };
}

/**
 * A floated overlay clips to the rows above the prompt box, so it never
 * covers the prompt. Losing a long body's tail to the clip is survivable;
 * losing every choice is not — the surface could not be answered. The box
 * slides down just far enough to keep the overlay's full, fraction-capped
 * height on screen; the starters below pay for the move.
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
   * Rows an open overlay cannot render without: border + title + one content
   * row. Below this, the box paints past its assigned height instead of
   * shrinking, so the resolver must never starve it.
   */
  readonly overlayMinBodyRows?: number;
}

/**
 * Rows the transcript gives up once a fleet is running: with several lanes
 * live the operator manages a fleet rather than reads a conversation. It
 * keeps only a live tail — the orchestrator reporting back and asking
 * questions is how the operator learns anything.
 */
export function fleetTranscriptFloor(shell: AppShell): {
  transcriptFloor?: number;
} {
  const bag = shellInternals(shell);
  if (!bag) return {};
  const lanes = bag.chrome.agents.filter((row) => row.kind === "lane").length;
  return lanes >= FLEET_FLOOR_MIN_LANES
    ? { transcriptFloor: FLEET_TRANSCRIPT_FLOOR }
    : {};
}
