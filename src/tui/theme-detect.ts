/**
 * Terminal/OS theme detection (CL-8993 phase 1).
 *
 * Precedence, highest first:
 *
 * 1. Explicit `theme` setting (`light` | `dark`; `auto` defers).
 * 2. Sync sniff of COLORFGBG (and TERM_PROGRAM, which currently carries no
 *    theme signal on its own — consulted so the step owns both vars).
 * 3. Async OSC 11 query (`queryTerminalBackground`, bounded timeout, dark on
 *    timeout — startup never blocks on the terminal answering).
 * 4. OS appearance (best-effort per platform; unknown platforms abstain).
 * 5. Default dark.
 *
 * Everything here is pure over injected inputs: no direct `process.env`,
 * `process.platform`, or stdin access. Callers read the environment once and
 * pass it in, which keeps the precedence matrix unit-testable and the one
 * impure edge (spawning `defaults`, writing the OSC query) in the startup
 * wiring. Nothing is cached across restarts — every launch re-detects.
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
 * Step 2: synchronous terminal sniff.
 *
 * COLORFGBG is `fg;bg` (xterm appends a third cursor field whose middle `bg`
 * still applies). A `default` background means "ask the terminal" — unknown,
 * never a guess. Numeric backgrounds follow the ANSI table: 0-6 and 8 are
 * dark grounds, 7 and 9-15 are light ones. TERM_PROGRAM names the terminal
 * but no current terminal encodes its light/dark state there, so it never
 * decides alone.
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

/**
 * Step 3: parse an OSC 11 background reply
 * (`ESC ] 11 ; rgb:RRRR/GGGG/BBBB ST`). Dark-first: unparseable replies and
 * the exact middle abstain (null) so the caller falls through to OS/default
 * dark rather than flashing light on garbage.
 */
export function parseOsc11Reply(reply: string): ThemeName | null {
  const match =
    /rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})/.exec(
      reply,
    );
  if (match === null) return null;
  const scale = (hex: string): number => {
    const width = hex.length;
    const v = Number.parseInt(hex, 16) / (16 ** width - 1);
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * scale(match[1] ?? "") +
    0.7152 * scale(match[2] ?? "") +
    0.0722 * scale(match[3] ?? "");
  if (luminance > 0.5) return "corbits-light";
  if (luminance < 0.5) return "corbits-dark";
  return null;
}

/**
 * Step 3 transport: race an injected OSC 11 query against a bounded timeout.
 * Never rejects and never outlives `timeoutMs` — an unanswered terminal
 * resolves null (dark-first downstream), never stalls startup.
 */
export async function queryTerminalBackground(
  query: () => Promise<string | null>,
  timeoutMs = 150,
): Promise<ThemeName | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const reply = await Promise.race([query(), timeout]);
    if (reply === null) return null;
    return parseOsc11Reply(reply);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type OsAppearanceRunner = (
  command: string,
  args: readonly string[],
) => string | null | undefined;

/**
 * Step 4: OS appearance, best-effort per platform over an injected runner.
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
  readonly osc: ThemeName | null;
  readonly os: ThemeName | null;
}

/**
 * The full precedence selector over already-gathered signals. Async signals
 * arrive as null until (and unless) they resolve, so calling this with
 * `{ osc: null, os: null }` is the sync startup answer and calling it again
 * with resolved values is the async upgrade — one function, no caching.
 */
export function resolveDetectedTheme(resolution: ThemeResolution): ThemeName {
  return (
    settingTheme(resolution.setting) ??
    sniffSyncTheme(resolution.syncEnv) ??
    resolution.osc ??
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
