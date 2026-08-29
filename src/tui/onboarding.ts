import { runTUI } from "./runner.js";
import { buildProviderSubmitHandler } from "./provider-setup-submit.js";
import { loadConfig, type UnconfiguredConfig } from "../config/index.js";
import {
  globalSettingsPath,
  loadSettings,
  markOnboarded,
  resolveLocalSettingsPath,
} from "../config/settings.js";
import { activateHeldTelemetry, telemetryFirstRunPending } from "../telemetry/first-run.js";
import { runProviderSetup } from "./provider-setup.js";
import { runWelcome } from "./welcome.js";

export async function runOnboarding(config: UnconfiguredConfig): Promise<number> {
  const settingsPath = config.globalSettingsPath;

  // Disclosure before any send: startup held telemetry because the notice
  // has never been shown, so render it here and treat a completed submit as
  // the affirmative action that activates telemetry (consent by proceeding).
  // Read from the TRUE global settings file — telemetry state never lives in
  // a --config override file.
  const trueGlobalPath = globalSettingsPath();
  const trueGlobalSettings = await loadSettings(trueGlobalPath).catch(() => null);
  const showTelemetryNotice = telemetryFirstRunPending(trueGlobalSettings);

  // Welcome is global first-run state (same TRUE global file as telemetry /
  // onboarded), independent of --config provider write targets. Already-
  // onboarded users who wiped providers jump straight to setup.
  if (trueGlobalSettings?.onboarded !== true) {
    const welcomed = await runWelcome();
    if (!welcomed) {
      return 1;
    }
    await markOnboarded(trueGlobalPath);
  }

  // Load the provider write-target after welcome so a same-path markOnboarded
  // is preserved when setup merges the new provider into existing settings.
  const existing = await loadSettings(settingsPath);

  const submitted = await runProviderSetup({
    showTelemetryNotice,
    existingProviderNames: Object.keys(existing?.providers ?? {}),
    onSubmit: buildProviderSubmitHandler(
      settingsPath,
      existing,
      resolveLocalSettingsPath(config.cwd, settingsPath),
    ),
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
    await activateHeldTelemetry(trueGlobalPath);
  }

  const argv: string[] = ["--cwd", config.cwd];
  if (config.cliConfigPath !== undefined) argv.push("--config", config.cliConfigPath);
  if (config.dangerouslySkipPermissions) argv.push("--dangerously-skip-permissions");
  if (config.force) argv.push("--force");
  if (config.task.length > 0) argv.push(config.task);

  // Preserve programmatic isolation independently of the path that won settings
  // precedence; CLI --config remains the write and reload target when both exist.
  const loadOptions = config.programmaticSettingsPath ? { globalSettingsPath: settingsPath } : {};
  const newConfig = await loadConfig(argv, loadOptions);
  return runTUI(newConfig);
}
