import { runTUI } from "./runner.js";
import { loadConfig, type UnconfiguredConfig } from "../config/index.js";
import {
  globalSettingsPath,
  loadSettings,
  mergeProviderIntoSettings,
  saveGlobalSettings,
} from "../config/settings.js";
import { activateHeldTelemetry, telemetryFirstRunPending } from "../telemetry/first-run.js";
import { validateProviderConnection } from "../provider/validate-connection.js";
import { runProviderSetup } from "../tui-opentui/provider-setup.js";

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
    onSubmit: async (values, setPhase, { skipValidation }) => {
      const { name, baseURL, apiKey, model } = values;
      const providerName = name.trim();
      const trimmedBaseURL = baseURL.trim();
      const trimmedKey = apiKey.trim();

      // Fail fast on a bad base URL/key here rather than mid-conversation
      // during the first real stream request. The operator can bypass the
      // check (Ctrl+S) for providers that don't expose /models.
      if (!skipValidation) {
        const check = await validateProviderConnection({
          baseURL: trimmedBaseURL,
          apiKey: trimmedKey.length > 0 ? trimmedKey : undefined,
        });
        if (!check.ok) {
          throw new Error(check.error);
        }
      }

      setPhase("saving");
      const newProvider = {
        baseURL: trimmedBaseURL,
        models: [model.trim()],
        defaultModel: model.trim(),
        ...(trimmedKey.length > 0 ? { apiKey: trimmedKey } : { keyless: true }),
      };
      // Merge new provider with any pre-existing ones. Single write — the form
      // stays open (phase label) until saveGlobalSettings resolves, so the user
      // sees confirmation before the screen is cleared. Full-spread merge so
      // plugins/pluginPaths/sessionMode/shell/tools survive re-onboarding.
      const merged = mergeProviderIntoSettings(existing, providerName, newProvider);
      await saveGlobalSettings(settingsPath, merged);
    },
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
  if (config.dangerouslySkipPermissions) argv.push("--dangerously-skip-permissions");
  if (config.force) argv.push("--force");
  if (config.task.length > 0) argv.push(config.task);

  const newConfig = await loadConfig(argv, { globalSettingsPath: settingsPath });
  return runTUI(newConfig);
}
