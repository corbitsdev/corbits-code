/**
 * Corbits terminal palette — the single source of truth for every color the
 * OpenTUI shell paints. Values are the corbits.dev brand system, not a
 * generic terminal scheme.
 *
 * Two rules the rest of the TUI depends on:
 *
 * 1. Gray never sits on black. Dimmed text is a dimmed *cream* (`textDim`,
 *    `textFaint`) so the warm bias survives at every emphasis level. There is
 *    deliberately no neutral gray in this file to reach for.
 * 2. Orange is spent once per screen. It marks the session and whatever awaits
 *    a human decision — nothing else. Ongoing status uses `inFlight` (blue) and
 *    `done` (green) so it never competes with the one thing asking to be
 *    answered. Diff removals are the sole exception: there the orange is
 *    content, not chrome, and no decision-marker shares the row.
 */

/**
 * Brand hues. Prefer the semantic `UI` roles below at call sites.
 *
 * Lowercase because the renderer normalizes hex that way, and tests compare a
 * painted span's `fg` against these constants directly.
 */
export const BRAND = {
  ground: "#000000",
  canvasCream: "#f7ead5",
  breakthroughOrange: "#e98428",
  breakthroughOrangeDark: "#bf6b20",
  summitBlue: "#607c9a",
  ridgeGreen: "#7b9974",
} as const

// Cream stepped down toward black rather than desaturated toward gray, so
// low-emphasis text keeps the same warm hue as full-emphasis text.
const CREAM_DIM = "#a89f91"
const CREAM_FAINT = "#6f6960"

// Summit Blue lifted toward cream for the one tier above body text that still
// has to read as cool (links, keywords, headings).
const SUMMIT_BLUE_BRIGHT = "#8aa4c0"

/** Semantic roles. Everything outside this file paints through these. */
export const UI = {
  ground: BRAND.ground,
  /** All body text. Never white, never gray. */
  text: BRAND.canvasCream,
  /** Secondary text: labels, context lines, chrome. */
  textDim: CREAM_DIM,
  /** Lowest emphasis: comments, concealed markdown syntax. */
  textFaint: CREAM_FAINT,
  /** The session mark and anything awaiting a human decision. */
  action: BRAND.breakthroughOrange,
  actionDim: BRAND.breakthroughOrangeDark,
  /** Work in progress, and cool informational accents. */
  inFlight: BRAND.summitBlue,
  inFlightBright: SUMMIT_BLUE_BRIGHT,
  /** Completed and succeeded. */
  done: BRAND.ridgeGreen,
} as const

export type UIColor = (typeof UI)[keyof typeof UI]
