/**
 * Startup theme wiring: gather the detection signals at the process edge and
 * publish the winning palette onto the live `UI` binding before any
 * renderable is constructed, so the first frame cannot mix palettes.
 */

import { spawnSync } from "node:child_process";

import {
  detectOsAppearance,
  resolveDetectedTheme,
  resolveThemeSetting,
  sniffSyncTheme,
  syncEnvFromRecord,
  type OsAppearanceRunner,
} from "./theme-detect.js";
import { setTheme, type ThemeName } from "./theme.js";

export interface StartupThemeOptions {
  readonly env?: Record<string, string | undefined>;
  readonly platform?: string;
  readonly runOsCommand?: OsAppearanceRunner;
}

function runOsAppearanceCommand(
  command: string,
  args: readonly string[],
): string | null | undefined {
  try {
    const out = spawnSync(command, [...args], {
      encoding: "utf8",
      timeout: 500,
    });
    if (out.error !== undefined) return undefined;
    if (out.status !== 0) return null;
    return typeof out.stdout === "string" ? out.stdout : undefined;
  } catch {
    return undefined;
  }
}

export function resolveStartupTheme(
  rawSetting: unknown,
  options: StartupThemeOptions = {},
): ThemeName {
  const setting = resolveThemeSetting(rawSetting);
  const syncEnv = syncEnvFromRecord(options.env ?? process.env);
  const os =
    setting === "auto" && sniffSyncTheme(syncEnv) === null
      ? detectOsAppearance(
          options.platform ?? process.platform,
          options.runOsCommand ?? runOsAppearanceCommand,
        )
      : null;
  return resolveDetectedTheme({ setting, syncEnv, os });
}

export function applyStartupTheme(
  rawSetting: unknown,
  options: StartupThemeOptions = {},
): ThemeName {
  const theme = resolveStartupTheme(rawSetting, options);
  setTheme(theme);
  return theme;
}
