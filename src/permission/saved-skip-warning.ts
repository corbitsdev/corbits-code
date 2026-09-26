export function savedSkipPermissionsWarning(
  globalSettingsPath: string,
): string {
  return `Warning: permission prompts are disabled by saved settings at ${globalSettingsPath}; edit that file to re-enable.`;
}
