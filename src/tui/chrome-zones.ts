// Fixed row budgets for each chrome zone. Sum feeds CHROME_ROWS in
// use-layout-geometry so the transcript height stays aligned with what App
// actually paints under/above the event log.

export const CHROME_ZONE_ROWS = {
  /** Header: profile/workflow row + optional latest user message. */
  header: 2,
  /** Hairline between the transcript and the progress/prompt stack. */
  progressDivider: 1,
  /** In-flight spinner / idle placeholder. */
  progress: 1,
  /** Profile · model · effort line above the prompt border (ChatInput action bar). */
  modelBar: 1,
  /** Round-bordered prompt: top border + content + bottom border. */
  prompt: 3,
  /** Status bar under the prompt. */
  status: 1,
} as const;

export type ChromeZone = keyof typeof CHROME_ZONE_ROWS;

export function sumChromeZoneRows(
  zones: { readonly [K in ChromeZone]: number } = CHROME_ZONE_ROWS,
): number {
  return (
    zones.header
    + zones.progressDivider
    + zones.progress
    + zones.modelBar
    + zones.prompt
    + zones.status
  );
}

/** Full-width hairline for the progress/prompt separator. */
export function chromeDividerLine(innerWidth: number): string {
  return "─".repeat(Math.max(8, innerWidth));
}
