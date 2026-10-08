/**
 * Terminal/OS theme detection. Precedence, highest first: explicit `theme`
 * setting (`light` | `dark`; `auto` defers), a sync COLORFGBG sniff,
 * OS appearance (best-effort per platform), then default dark. TERM_PROGRAM
 * carries no theme signal on its own — consulted so the step owns both vars.
 *
 * Pure over injected inputs: no direct `process.env`, `process.platform`,
 * or stdin access, so the precedence matrix stays unit-testable. Nothing is
 * cached across restarts; every launch re-detects.
 */

import type { ThemeName } from "./theme.js";

export type ThemeSetting = "auto" | "light" | "dark";

const SETTING_THEMES: Record<Exclude<ThemeSetting, "auto">, ThemeName> = {
  light: "corbits-light",
  dark: "corbits-dark",
};

/** Validate a raw settings value. Unknown values fall back to `auto`. */
export function resolveThemeSetting(raw: unknown): ThemeSetting {
  return raw === "light" || raw === "dark" || raw === "auto" ? raw : "auto";
}

/** Step 1: an explicit setting short-circuits everything below it. */
export function settingTheme(setting: ThemeSetting): ThemeName | null {
  return setting === "auto" ? null : SETTING_THEMES[setting];
}

export interface SyncThemeEnv {
  readonly COLORFGBG?: string;
  readonly TERM_PROGRAM?: string;
}

/**
 * Step 2: synchronous terminal sniff. COLORFGBG is `fg;bg` (xterm appends
 * a third cursor field whose middle `bg` still applies). A `default`
 * background means "ask the terminal" — unknown, never a guess. Numeric
 * backgrounds follow the ANSI table: 0-6 and 8 dark grounds, 7 and 9-15
 * light. TERM_PROGRAM alone never decides.
 */
export function sniffSyncTheme(env: SyncThemeEnv): ThemeName | null {
  const parts = (env.COLORFGBG ?? "").split(";");
  const bg = parts.length >= 2 ? parts[1]?.trim() : undefined;
  if (bg === undefined || bg === "" || bg.toLowerCase() === "default") {
    return null;
  }
  if (!/^\d+$/.test(bg)) return null;
  const n = Number(bg);
  if (n === 7 || (n >= 9 && n <= 15)) return "corbits-light";
  if ((n >= 0 && n <= 6) || n === 8) return "corbits-dark";
  return null;
}

export type OsAppearanceRunner = (
  command: string,
  args: readonly string[],
) => string | null | undefined;

/**
 * Step 3: OS appearance, best-effort per platform over an injected runner.
 * macOS reads the global AppleInterfaceStyle default (`Dark` = dark; a
 * missing key means the Light default). Other platforms abstain — null is a
 * normal answer, not an error.
 */
export function detectOsAppearance(
  platform: string,
  run: OsAppearanceRunner,
): ThemeName | null {
  if (platform !== "darwin") return null;
  let out: string | null | undefined;
  try {
    out = run("defaults", ["read", "-g", "AppleInterfaceStyle"]);
  } catch {
    return null;
  }
  if (out === undefined) return null;
  if (out === null) return "corbits-light";
  return out.trim().toLowerCase() === "dark" ? "corbits-dark" : "corbits-light";
}

export interface ThemeResolution {
  readonly setting: ThemeSetting;
  readonly syncEnv: SyncThemeEnv;
  readonly os: ThemeName | null;
}

/** Select the final theme from signals gathered before the TUI is constructed. */
export function resolveDetectedTheme(resolution: ThemeResolution): ThemeName {
  return (
    settingTheme(resolution.setting) ??
    sniffSyncTheme(resolution.syncEnv) ??
    resolution.os ??
    "corbits-dark"
  );
}

/** Read the sync env slice out of a `process.env`-shaped record. */
export function syncEnvFromRecord(
  env: Record<string, string | undefined>,
): SyncThemeEnv {
  return {
    ...(env.COLORFGBG !== undefined ? { COLORFGBG: env.COLORFGBG } : {}),
    ...(env.TERM_PROGRAM !== undefined
      ? { TERM_PROGRAM: env.TERM_PROGRAM }
      : {}),
  };
}
