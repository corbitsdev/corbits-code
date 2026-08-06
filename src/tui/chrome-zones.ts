// Fixed row budgets for each chrome zone. The sum keeps the transcript height
// aligned with what the session chrome actually paints under/above the event log.

export const CHROME_ZONE_ROWS = {
  /** Header: profile/workflow row + optional latest user message. */
  header: 2,
  /** Hairline between the transcript and the progress/prompt stack. */
  progressDivider: 1,
  /**
   * InFlightIndicator when visible: marginTop={1} + one content line.
   * Not part of the fixed sum — reserved only via progressChromeRowCount so
   * idle sessions do not keep an empty progress spacer.
   */
  progress: 2,
  /** Profile · model · effort line above the prompt border (ChatInput action bar). */
  modelBar: 1,
  /** Round-bordered prompt: top border + content + bottom border. */
  prompt: 3,
  /** StatusBar under the prompt: App's marginTop={1} wrapper + one content line. */
  status: 2,
} as const;

export type ChromeZone = keyof typeof CHROME_ZONE_ROWS;

/** Always-present chrome (excludes optional progress, which is added when shown). */
export function sumChromeZoneRows(
  zones: { readonly [K in ChromeZone]: number } = CHROME_ZONE_ROWS,
): number {
  return (
    zones.header
    + zones.progressDivider
    + zones.modelBar
    + zones.prompt
    + zones.status
  );
}

/** True when the progress row has anything to paint (live phase or workflow chip). */
export function shouldShowProgressRow(input: {
  active: boolean;
  hasWorkflow: boolean;
}): boolean {
  return input.active || input.hasWorkflow;
}

/** Rows the progress zone occupies when the phase/workflow line is painted. */
export function progressChromeRowCount(input: {
  active: boolean;
  hasWorkflow: boolean;
}): number {
  return shouldShowProgressRow(input) ? CHROME_ZONE_ROWS.progress : 0;
}

/** Full-width hairline for the progress/prompt separator. */
export function chromeDividerLine(innerWidth: number): string {
  return "─".repeat(Math.max(8, innerWidth));
}
