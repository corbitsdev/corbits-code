import {
  globalSettingsPath as defaultGlobalSettingsPath,
  isProgrammaticSettingsOverride,
} from "../config/settings.js";

function isDefaultSettingsSource(sourcePath: string): boolean {
  return !isProgrammaticSettingsOverride(
    sourcePath,
    defaultGlobalSettingsPath(),
  );
}

export function savedSkipPermissionsWarning(
  globalSettingsPath: string,
  surface: "tui" | "exec",
): string {
  const base = `Warning: permission prompts are disabled by saved settings at ${globalSettingsPath}; edit that file to re-enable`;
  if (surface === "tui" && isDefaultSettingsSource(globalSettingsPath)) {
    return `${base} (/yolo off to re-enable).`;
  }
  return `${base}.`;
}
