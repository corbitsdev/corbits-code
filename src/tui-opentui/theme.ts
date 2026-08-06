/**
 * Corbits terminal palette — the single source of truth for every color the
 * OpenTUI shell paints.
 *
 * Three rules the rest of the TUI depends on:
 *
 * 1. Gray never sits on the ground. Dimmed text is a dimmed *cream*
 *    (`textDim`, `textFaint`) so the warm bias survives at every emphasis
 *    level. There is deliberately no neutral gray in this file to reach for.
 * 2. Orange is spent once per screen. It marks the session and whatever awaits
 *    a human decision — nothing else. Ongoing status uses the bronze ramp and
 *    `done` (green) so it never competes with the one thing asking to be
 *    answered. Diff removals are the sole exception: there the orange is
 *    content, not chrome, and no decision-marker shares the row.
 * 3. The chrome ramp is warm but never saturated. Every bronze sits at or
 *    below 54% HSL saturation against Breakthrough Orange's 81%, so full
 *    orange still arrives as an event rather than as another shade of the
 *    furniture.
 *
 * The product owner has deliberately dropped Summit Blue from the terminal:
 * cool information read as foreign against cream, black and orange chrome. The
 * brand's discipline is kept — small palette, roles not decoration, no hue
 * without a job — only the cool end of it is replaced by warm structure.
 */

/**
 * Palette values a theme supplies. Call sites paint through `UI`, never
 * through a theme directly, so a second theme is a data change here.
 */
export type Theme = {
  readonly name: string
  /** Terminal ground. Foreground-only discipline means almost nothing fills it. */
  readonly ground: string
  /** All body text. Never white, never gray. */
  readonly text: string
  /** Secondary text: labels, context lines, chrome. */
  readonly textDim: string
  /** Lowest emphasis: comments, concealed markdown syntax. */
  readonly textFaint: string
  /** The session mark and anything awaiting a human decision. */
  readonly action: string
  readonly actionDim: string
  /** Work in progress: ramps, tool verbs, machine output threaded into prose. */
  readonly inFlight: string
  /** The tier above body text that still reads as machine: keywords, links, args. */
  readonly inFlightBright: string
  /** Document structure: markdown headings and section rules. */
  readonly heading: string
  /** Completed and succeeded. */
  readonly done: string
}

/**
 * Brand hues, plus the warm ramp that replaced Summit Blue.
 *
 * Lowercase because the renderer normalizes hex that way, and tests compare a
 * painted span's `fg` against these constants directly.
 */
export const BRAND = {
  // Charcoal rather than pure black: it lifts the interface off the host
  // terminal's own background and softens the cream's contrast edge, while
  // staying dark enough that `textFaint` keeps a readable margin above it.
  ground: "#191614",
  canvasCream: "#f7ead5",
  breakthroughOrange: "#e98428",
  breakthroughOrangeDark: "#bf6b20",
  ridgeGreen: "#7b9974",
} as const

// Cream stepped down toward the ground rather than desaturated toward gray, so
// low-emphasis text keeps the same warm hue as full-emphasis text.
const CREAM_DIM = "#a89f91"
const CREAM_FAINT = "#787166"

// The warm chrome ramp. Three tones so the roles that once shared a blue stay
// separable — they differ in lightness first, hue second, and all three sit
// well under the action orange's saturation.
const BRONZE = "#93733f" // dimmest: motion and machine chrome
const SAND = "#d1ad7d" // brightest: keywords, links, command arguments
const EMBER = "#a97243" // burnt, between the two: document structure

export const corbitsDark: Theme = {
  name: "corbits-dark",
  ground: BRAND.ground,
  text: BRAND.canvasCream,
  textDim: CREAM_DIM,
  textFaint: CREAM_FAINT,
  action: BRAND.breakthroughOrange,
  actionDim: BRAND.breakthroughOrangeDark,
  inFlight: BRONZE,
  inFlightBright: SAND,
  heading: EMBER,
  done: BRAND.ridgeGreen,
}

/** Every theme that ships. A picker would choose from here. */
export const THEMES = { [corbitsDark.name]: corbitsDark } as const

/** Semantic roles. Everything outside this file paints through these. */
export const UI: Theme = corbitsDark

export type UIColor = Theme[keyof Theme]
