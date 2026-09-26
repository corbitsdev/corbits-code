import { globalSettingsPath as defaultGlobalSettingsPath } from "../config/settings.js";

function isDefaultSettingsSource(sourcePath: string): boolean {
  return sourcePath === defaultGlobalSettingsPath();
}

export function savedSkipPermissionsWarning(
  globalSettingsPath: string,
): string {
  const base = `Warning: permission prompts are disabled by saved settings at ${globalSettingsPath}; edit that file to re-enable`;
  if (isDefaultSettingsSource(globalSettingsPath)) {
    return `${base} (/yolo off to re-enable).`;
  }
  return `${base}.`;
}
