/**
 * Corbits terminal palette — the single source of truth for every color the
 * OpenTUI shell paints.
 *
 * Three rules the rest of the TUI depends on:
 *
 * 1. Gray never sits on the ground. Dimmed text is a dimmed *cream*
 *    (`textDim`, `textFaint`) so the warm bias survives at every emphasis
 *    level. There is deliberately no neutral gray in this file to reach for.
 * 2. Orange is spent once per screen. It marks the session and whatever
 *    awaits a human decision — nothing else. Ongoing status uses the bronze
 *    ramp and `done` (green) so it never competes with the one thing asking
 *    to be answered. Diff removals are the sole exception: there the orange
 *    is content, not chrome.
 * 3. The chrome ramp is warm but never saturated. Every bronze sits at or
 *    below 54% HSL saturation against Breakthrough Orange's 81%, so full
 *    orange still arrives as an event rather than as another shade of the
 *    furniture.
 *
 * Summit Blue is deliberately absent: cool information read as foreign
 * against cream, black and orange chrome. The brand's discipline is kept —
 * small palette, roles not decoration, no hue without a job — only the cool
 * end of it is replaced by warm structure.
 */

/**
 * Palette values a theme supplies. Call sites paint through `UI`, never
 * through a theme directly, so a second theme is a data change here.
 */
export interface Theme {
  readonly name: string;
  /** Terminal ground. Foreground-only discipline means almost nothing fills it. */
  readonly ground: string;
  /** All body text. Never white, never gray. */
  readonly text: string;
  /** Secondary text: labels, context lines, chrome. */
  readonly textDim: string;
  /** Lowest emphasis: comments, concealed markdown syntax. */
  readonly textFaint: string;
  /** The session mark and anything awaiting a human decision. */
  readonly action: string;
  readonly actionDim: string;
  /** Work in progress: ramps, tool verbs, machine output threaded into prose. */
  readonly inFlight: string;
  /** The tier above body text that still reads as machine: keywords, links, args. */
  readonly inFlightBright: string;
  /** Document structure: markdown headings and section rules. */
  readonly heading: string;
  /** Completed and succeeded. */
  readonly done: string;
  /** Standing caution: attention marks, meter warning band. */
  readonly warning: string;
  /** Failure and the meter danger band. */
  readonly error: string;
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
} as const;

// Cream stepped down toward the ground rather than desaturated toward gray, so
// low-emphasis text keeps the same warm hue as full-emphasis text.
const CREAM_DIM = "#a89f91";
const CREAM_FAINT = "#787166";

// The warm chrome ramp. Three tones so the roles that once shared a blue stay
// separable — they differ in lightness first, hue second, and all three sit
// well under the action orange's saturation.
const BRONZE = "#93733f"; // dimmest: motion and machine chrome
const SAND = "#d1ad7d"; // brightest: keywords, links, args, and standing caution
const EMBER = "#a97243"; // burnt, between the two: document structure
const ERROR_RED = "#e0594d"; // meter danger band, failures

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
  warning: SAND,
  error: ERROR_RED,
};

/**
 * Light companion to `corbitsDark`: the same roles on a warm light ground.
 *
 * Data-only — no interface change, no new roles, no per-theme branches at
 * call sites. Every value was picked by relative luminance against the cream
 * ground, not by eye: body text holds ~14:1 (near the dark theme's ~15:1),
 * and every essential text role holds >=4.5:1. Orange still appears once per
 * screen (action/actionDim); it is darkened here because Breakthrough Orange
 * itself is ~2.3:1 on cream and unreadable as text. The bronze ramp is
 * darkened for the same reason SAND is ~1.8:1 on cream. Dimmed text is a
 * dimmed ink, never a neutral gray, so the warm bias survives at every
 * emphasis level. Standing caution moves to a muted plum: a bronze warning
 * collapses into the machine ramp on cream, while red or orange would spend
 * the failure/action hues.
 *
 * The warm roles separate by lightness first, hue second. Action is the
 * darkest warm (~10.5:1) and the most saturated, so the decision marker never
 * shares a step with chrome. The dim tier (actionDim, inFlight) sits near
 * ~6.4-7:1 and the bright tier (inFlightBright, heading) at ~4.5:1; each
 * intra-ramp step spans >=1.5:1 so each ramp still reads as a ramp.
 * Same-tier collisions across ramps are carried by hue and saturation:
 * actionDim stays orange against the olive machine, and the gold heading
 * out-saturates the tan machine-bright.
 */
export const corbitsLight: Theme = {
  name: "corbits-light",
  ground: BRAND.canvasCream,
  text: "#221d18",
  textDim: "#57493d",
  textFaint: "#746658",
  action: "#55270c",
  actionDim: "#7a4824",
  inFlight: "#564e38",
  inFlightBright: "#7d6836",
  heading: "#856619",
  done: "#3f6b3a",
  warning: "#655275",
  error: "#b03a30",
};

const THEMES = {
  "corbits-dark": corbitsDark,
  "corbits-light": corbitsLight,
} as const;

export type ThemeName = keyof typeof THEMES;

/** Resolve a theme name to its palette. Unknown names fall back to dark. */
export function resolveThemeName(name: string): Theme {
  return (THEMES as Record<string, Theme>)[name] ?? corbitsDark;
}

let activeTheme: Theme = corbitsDark;

/**
 * Reset hooks for paint state derived from the palette. Modules that snapshot
 * palette values into renderer-owned registries (a SyntaxStyle) register a
 * reset here; `setTheme` runs every hook right after swapping `UI`, so no
 * stale palette survives a pin change. The single choke point stays here —
 * call sites never reset caches themselves.
 */
type ThemeCacheReset = () => void;

const themeCacheResets = new Set<ThemeCacheReset>();

export function onThemeChange(reset: ThemeCacheReset): () => void {
  themeCacheResets.add(reset);
  return () => {
    themeCacheResets.delete(reset);
  };
}

/**
 * Switch the live `UI` binding to the named theme, keeping the reference.
 * Everything outside this file paints through `UI`, so existing readers pick
 * the change up without re-importing. Never reassign or destructure this
 * binding — `const { text } = UI` snapshots the old palette forever.
 */
export function setTheme(name: ThemeName | string): Theme {
  activeTheme = resolveThemeName(name);
  Object.assign(UI, activeTheme);
  for (const reset of themeCacheResets) reset();
  return activeTheme;
}

/**
 * Semantic roles. Everything outside this file paints through these.
 *
 * A settable live binding, not a frozen value: `setTheme` copies the next
 * palette onto this same object. The default is dark; startup detection
 * selects the final theme before renderables are constructed.
 */
export const UI: Theme = { ...corbitsDark };
