import { runTUI } from "./runner.js";
import { buildProviderSubmitHandler } from "./provider-setup-submit.js";
import { loadConfig, type UnconfiguredConfig } from "../config/index.js";
import { globalSettingsPath, loadSettings, localSettingsPath } from "../config/settings.js";
import { activateHeldTelemetry, telemetryFirstRunPending } from "../telemetry/first-run.js";
import { runProviderSetup } from "./provider-setup.js";

export async function runOnboarding(config: UnconfiguredConfig): Promise<number> {
  const settingsPath = config.globalSettingsPath;
  const existing = await loadSettings(settingsPath);

  // Disclosure before any send: startup held telemetry because the notice
  // has never been shown, so render it here and treat a completed submit as
  // the affirmative action that activates telemetry (consent by proceeding).
  // Read from the TRUE global settings file — telemetry state never lives in
  // a --config override file.
  const trueGlobalSettings = await loadSettings(globalSettingsPath()).catch(() => null);
  const showTelemetryNotice = telemetryFirstRunPending(trueGlobalSettings);

  const submitted = await runProviderSetup({
    showTelemetryNotice,
    existingProviderNames: Object.keys(existing?.providers ?? {}),
    onSubmit: buildProviderSubmitHandler(settingsPath, existing, localSettingsPath(config.cwd)),
  });

  // If the user cancelled (Ctrl+C) onSubmit was never called and settings were
  // never written. Skip launching the TUI — and leave telemetry held, so a
  // cancelled first run sends nothing.
  if (!submitted) {
    return 1;
  }

  // Completing setup with the disclosure on screen is the affirmative action
  // that unlocks telemetry and fires the held cli_start.
  if (showTelemetryNotice) {
    await activateHeldTelemetry(globalSettingsPath());
  }

  const argv: string[] = ["--cwd", config.cwd];
  if (config.cliConfigPath !== undefined) argv.push("--config", config.cliConfigPath);
  if (config.dangerouslySkipPermissions) argv.push("--dangerously-skip-permissions");
  if (config.force) argv.push("--force");
  if (config.task.length > 0) argv.push(config.task);

  // Recreate the original source rather than comparing paths: CLI --config
  // composes with home OAuth profiles, while a programmatic override is an
  // isolated settings source even if it names the default settings path.
  const loadOptions =
    config.settingsSource === "programmatic" ? { globalSettingsPath: settingsPath } : {};
  const newConfig = await loadConfig(argv, loadOptions);
  return runTUI(newConfig);
}
