/**
 * Startup check that our column arithmetic and OpenTUI's width table agree.
 *
 * The shell budgets every wrap/pad/truncation with `stringWidth`, but cells
 * come from OpenTUI's native table, negotiated with the terminal at boot. A
 * disagreement on East Asian Ambiguous characters — most of the chrome —
 * shortens every border.
 *
 * A mismatch is reported, never fatal, never silent: a silently wrong paint
 * is the failure mode this check removes.
 */

import {
  OptimizedBuffer,
  ResourceContext,
  type WidthMethod,
} from "@opentui/core";

import { stringWidth, WIDTH_PROBE } from "./view/height.js";

export interface WidthContractReport {
  readonly agrees: boolean;
  readonly probe: string;
  readonly ours: number;
  readonly renderer: number;
  readonly widthMethod: WidthMethod;
}

/** Width OpenTUI's own table assigns `text`, or null when it cannot encode it.
 *
 * 0.6.x moves `encodeUnicode` off the render lib onto a Context-owned buffer,
 * so the measure builds its own throwaway Context. `objectCapacity: 1,
 * renderCellsMax: 1` is not OpenTUI's internal shape (ImageOwner keeps a live
 * 4096/1 context); this call is one-shot and self-destroying, and 1/1 is the
 * tightest capacity the probe verifies as sufficient to encode and free. An
 * encode failure still reads as null — this check reports, never throws. */
export function measureRendererWidth(
  text: string,
  widthMethod: WidthMethod,
): number | null {
  const owner = new ResourceContext({ objectCapacity: 1, renderCellsMax: 1 });
  const buffer = OptimizedBuffer.create(1, 1, widthMethod, { owner });
  try {
    let encoded;
    try {
      encoded = buffer.encodeUnicode(text);
    } catch {
      return null;
    }
    if (encoded === null) return null;
    try {
      return encoded.data.reduce((n, cell) => n + cell.width, 0);
    } finally {
      buffer.freeUnicode(encoded);
    }
  } finally {
    try {
      buffer.destroy();
    } finally {
      owner.destroy();
    }
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
