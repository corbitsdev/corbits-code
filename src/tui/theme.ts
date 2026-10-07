/**
 * Corbits terminal palette — the single source of truth for every color the
 * shell paints. Three rules the rest of the TUI depends on:
 *
 * 1. No neutral gray: dimmed text is a dimmed cream, so the warm bias holds
 *    at every emphasis level.
 * 2. Orange is spent once per screen — the session mark and pending human
 *    decisions only. Diff removals are the exception (content, not chrome);
 *    ongoing status stays on the bronze ramp / `done` green.
 * 3. The chrome ramp is warm but never saturated: every bronze sits at or
 *    below 54% HSL saturation against Breakthrough Orange's 81%, so full
 *    orange arrives as an event, not another shade of furniture.
 *
 * Summit Blue is deliberately absent — cool reads foreign against cream,
 * black and orange chrome.
 */

/** Palette values a theme supplies. Call sites paint through `UI`, never a
 * theme directly, so a second theme is a data change here. */
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

/** Brand hues, plus the warm ramp that replaced Summit Blue. Lowercase: the
 * renderer normalizes hex that way and tests compare a painted span's `fg`
 * against these constants directly. */
export const BRAND = {
  // Charcoal, not pure black: lifts the interface off the host terminal's
  // background and keeps `textFaint` readable against the cream.
  ground: "#191614",
  canvasCream: "#f7ead5",
  breakthroughOrange: "#e98428",
  breakthroughOrangeDark: "#bf6b20",
  ridgeGreen: "#7b9974",
} as const;

// Cream dimmed toward the ground, not toward gray: low-emphasis text keeps
// the same warm hue as full-emphasis text.
const CREAM_DIM = "#a89f91";
const CREAM_FAINT = "#787166";

// The warm chrome ramp: three tones separable by lightness first, hue
// second, all under the action orange's saturation.
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
 * Data-only — no interface change, no new roles, no per-theme branches.
 *
 * Values were picked by relative luminance against the cream ground, not by
 * eye: body text holds ~14:1 (near the dark theme's ~15:1) and every
 * essential role >=4.5:1. The dark rules carry over: action stays a
 * one-per-screen decision marker (darkened — Breakthrough Orange is ~2.3:1
 * on cream), dimmed text is dimmed ink, and the bronze ramp is darkened.
 * Caution moves to a muted plum: a bronze warning collapses into the machine
 * ramp on cream. Warm roles separate by lightness first, hue and saturation
 * second, so the decision marker never shares a step with chrome and each
 * ramp still reads as a ramp.
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

/** Paint state derived from the palette (a SyntaxStyle) registers a reset
 * here; `setTheme` runs every hook after swapping `UI`, so no stale palette
 * survives a pin change. The choke point stays here — call sites never reset
 * caches themselves. */
type ThemeCacheReset = () => void;

const themeCacheResets = new Set<ThemeCacheReset>();

export function onThemeChange(reset: ThemeCacheReset): () => void {
  themeCacheResets.add(reset);
  return () => {
    themeCacheResets.delete(reset);
  };
}

/** Swap the live `UI` binding to the named theme. Never reassign or
 * destructure `UI` — `const { text } = UI` snapshots the old palette
 * forever. */
export function setTheme(name: ThemeName | string): Theme {
  activeTheme = resolveThemeName(name);
  Object.assign(UI, activeTheme);
  for (const reset of themeCacheResets) reset();
  return activeTheme;
}

/** Semantic roles everything outside this file paints through. A live
 * binding `setTheme` copies onto; default dark, startup detection picks the
 * final theme before renderables are built. */
export const UI: Theme = { ...corbitsDark };
