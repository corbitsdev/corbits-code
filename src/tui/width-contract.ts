/**
 * Startup check that our column arithmetic and OpenTUI's width table agree.
 *
 * Every wrap, pad and truncation budget in the shell is computed with
 * `stringWidth` (see `./view/height.ts`), but the cells are actually
 * allocated by OpenTUI's native table, negotiated with the terminal at boot.
 * The two only have to disagree on East Asian Ambiguous characters — which is
 * most of what the chrome is drawn from — for every border to come out short.
 *
 * A mismatch is reported, never fatal. A user whose terminal genuinely reports
 * a different table should still get a usable shell, and killing the process
 * over a column of border is a worse outcome than a warning. But it is also
 * never silent: a silently wrong paint is the failure mode this check exists
 * to remove.
 */

import { resolveRenderLib, type WidthMethod } from "@opentui/core"

import { stringWidth, WIDTH_PROBE } from "./view/height.js"

export type WidthContractReport = {
  readonly agrees: boolean
  readonly probe: string
  readonly ours: number
  readonly renderer: number
  readonly widthMethod: WidthMethod
}

/** Width OpenTUI's own table assigns `text`, or null when it cannot encode it. */
export function measureRendererWidth(
  text: string,
  widthMethod: WidthMethod,
): number | null {
  const lib = resolveRenderLib()
  const encoded = lib.encodeUnicode(text, widthMethod)
  if (encoded === null) return null
  try {
    return encoded.data.reduce((n, cell) => n + cell.width, 0)
  } finally {
    lib.freeUnicode(encoded)
  }
}

/**
 * Compare the probe's width under both tables. An unmeasurable probe counts as
 * agreement: the check exists to catch a divergence it can see, not to fail the
 * shell because the native measurement was unavailable.
 */
export function checkWidthContract(
  widthMethod: WidthMethod,
  measure: (text: string, method: WidthMethod) => number | null = measureRendererWidth,
): WidthContractReport {
  const ours = stringWidth(WIDTH_PROBE)
  const renderer = measure(WIDTH_PROBE, widthMethod)
  return {
    agrees: renderer === null || renderer === ours,
    probe: WIDTH_PROBE,
    ours,
    renderer: renderer ?? ours,
    widthMethod,
  }
}

/** Operator-facing wording for a failed check. Empty when the check passed. */
export function widthContractNotice(report: WidthContractReport): string {
  if (report.agrees) return ""
  return (
    `Terminal width mismatch: this terminal's ${report.widthMethod} table measures ` +
    `the layout probe at ${report.renderer} columns, the shell assumes ${report.ours}. ` +
    "Borders and truncation may be off by a column; set your terminal to treat " +
    "ambiguous-width characters as single-width."
  )
}
