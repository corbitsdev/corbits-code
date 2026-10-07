/**
 * Startup check that our column arithmetic and OpenTUI's width table agree.
 *
 * The shell budgets every wrap/pad/truncation with `stringWidth`, but cells
 * are allocated by OpenTUI's native table, negotiated with the terminal at
 * boot. A disagreement on East Asian Ambiguous characters — most of what the
 * chrome is drawn from — shortens every border.
 *
 * A mismatch is reported, never fatal, and never silent: a silently wrong
 * paint is the failure mode this check exists to remove.
 */

import { resolveRenderLib, type WidthMethod } from "@opentui/core";

import { stringWidth, WIDTH_PROBE } from "./view/height.js";

export interface WidthContractReport {
  readonly agrees: boolean;
  readonly probe: string;
  readonly ours: number;
  readonly renderer: number;
  readonly widthMethod: WidthMethod;
}

/** Width OpenTUI's own table assigns `text`, or null when it cannot encode it. */
export function measureRendererWidth(
  text: string,
  widthMethod: WidthMethod,
): number | null {
  const lib = resolveRenderLib();
  const encoded = lib.encodeUnicode(text, widthMethod);
  if (encoded === null) return null;
  try {
    return encoded.data.reduce((n, cell) => n + cell.width, 0);
  } finally {
    lib.freeUnicode(encoded);
  }
}

/**
 * Compare the probe's width under both tables. An unmeasurable probe counts
 * as agreement: the check catches a divergence it can see, not a native
 * measurement that was unavailable.
 */
export function checkWidthContract(
  widthMethod: WidthMethod,
  measure: (
    text: string,
    method: WidthMethod,
  ) => number | null = measureRendererWidth,
): WidthContractReport {
  const ours = stringWidth(WIDTH_PROBE);
  const renderer = measure(WIDTH_PROBE, widthMethod);
  return {
    agrees: renderer === null || renderer === ours,
    probe: WIDTH_PROBE,
    ours,
    renderer: renderer ?? ours,
    widthMethod,
  };
}

/** Operator-facing wording for a failed check. Empty when the check passed. */
export function widthContractNotice(report: WidthContractReport): string {
  if (report.agrees) return "";
  return (
    `Terminal width mismatch: this terminal's ${report.widthMethod} table measures ` +
    `the layout probe at ${report.renderer} columns, the shell assumes ${report.ours}. ` +
    "Borders and truncation may be off by a column; set your terminal to treat " +
    "ambiguous-width characters as single-width."
  );
}
