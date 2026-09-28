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
export interface Theme {
  readonly name: string;
  /** Opaque control backing and canvas fallback for this palette. */
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
const CREAM_FAINT = "#877f73";

// The warm chrome ramp. Three tones so the roles that once shared a blue stay
// separable — they differ in lightness first, hue second, and all three sit
// well under the action orange's saturation.
const BRONZE = "#9d7b44"; // dimmest: motion and machine chrome
const SAND = "#d1ad7d"; // brightest: keywords, links, and args
const CAUTION_GOLD = "#d6ba68"; // standing caution, distinct from machine emphasis
const EMBER = "#aa7444"; // burnt, between the two: document structure
const ERROR_RED = "#e0594d"; // meter danger band, failures
// Light-theme caution moves to muted plum: yellow/bronze collapses into the
// machine ramp on cream, while red or orange would compete with failure/action.
const LIGHT_WARNING = "#655275";

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
  warning: CAUTION_GOLD,
  error: ERROR_RED,
};

/**
 * Light companion to `corbitsDark`: the same roles on a warm light ground.
 *
 * Data-only — no interface change. Every value was picked by relative
 * luminance against the cream ground, not by eye: body text holds ~14:1
 * (near the dark theme's ~15:1), and every essential text role holds >=4.5:1.
 * Orange still appears once per screen (action/actionDim); it is darkened here because Breakthrough Orange
 * itself is ~2.3:1 on cream and unreadable as text. The bronze ramp is
 * darkened for the same reason SAND is ~1.8:1 on cream.
 */
export const corbitsLight: Theme = {
  name: "corbits-light",
  ground: BRAND.canvasCream,
  text: "#221d18",
  textDim: "#6b5f50",
  textFaint: "#74695b",
  action: "#8f4f16",
  actionDim: "#9b4f10",
  inFlight: "#6f5427",
  inFlightBright: "#7a5a22",
  heading: "#7c4f24",
  done: "#3f6b3a",
  warning: LIGHT_WARNING,
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

/**
 * Semantic roles. Everything outside this file paints through these.
 *
 * A settable live binding, not a frozen value: `setTheme` copies the next
 * palette onto this same object so every existing `UI.text`-style reader
 * picks the change up without re-importing. Never reassign or destructure
 * this binding — `const { text } = UI` snapshots the old palette forever.
 */
export interface UITheme extends Theme {
  /** Effective fill for canvas and root surfaces. */
  readonly canvasGround: string;
}

export const UI: UITheme = {
  ...corbitsDark,
  canvasGround: corbitsDark.ground,
};

const themeChangeListeners = new Set<(theme: Theme) => void>();

/** Keep a derived theme record synchronized with the live palette. */
export function onThemeChange(listener: (theme: Theme) => void): void {
  themeChangeListeners.add(listener);
  listener(UI);
}

let activeTheme: Theme = corbitsDark;
let transparentBackgroundEnabled = false;

function publishTheme(): UITheme {
  Object.assign(UI, activeTheme, {
    canvasGround: transparentBackgroundEnabled
      ? TRANSPARENT_BACKGROUND
      : activeTheme.ground,
  });
  for (const listener of themeChangeListeners) listener(UI);
  return UI;
}

/** Switch the live `UI` binding to the named theme, keeping the reference. */
export function setTheme(name: ThemeName | string): Theme {
  activeTheme = resolveThemeName(name);
  return publishTheme();
}

export const TRANSPARENT_BACKGROUND = "transparent";

const TRANSPARENT_BG_ENV_VAR = "CORBITS_TRANSPARENT_BACKGROUND";

export interface TransparentBackgroundEnv {
  readonly [key: string]: string | undefined;
  readonly CORBITS_TRANSPARENT_BACKGROUND?: string;
}

export function isTransparentBackgroundRequested(
  env: TransparentBackgroundEnv = process.env,
): boolean {
  const raw = env[TRANSPARENT_BG_ENV_VAR]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Publish the explicit canvas-transparency preference before surfaces build.
 * OpenTUI accepts transparent fills, so no terminal identity proxy is needed.
 */
export function configureTransparentBackground(
  env: TransparentBackgroundEnv = process.env,
): boolean {
  transparentBackgroundEnabled = isTransparentBackgroundRequested(env);
  publishTheme();
  return transparentBackgroundEnabled;
}
