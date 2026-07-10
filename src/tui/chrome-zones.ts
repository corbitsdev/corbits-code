// Fixed row budget for the bottom chrome stack (see use-layout-geometry CHROME_ROWS).
export const CHROME_ZONE_ROWS = {
  headerMax: 2,
  inFlight: 1,
  promptBoxBase: 3,
  status: 1,
} as const;

export const CHROME_DIVIDER = "─".repeat(24);