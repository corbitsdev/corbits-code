import { runTUI } from "./runner.js";
import { loadConfig, type UnconfiguredConfig } from "../config/index.js";
import {
  globalSettingsPath,
  loadSettings,
  localSettingsPath,
  mergeProviderIntoSettings,
  saveGlobalSettings,
  saveLocalSettings,
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
    onSubmit: async (values, setPhase, { skipValidation, preset, oauth }) => {
      const { name, baseURL, apiKey, model } = values;
      const providerName = name.trim();
      const trimmedBaseURL = baseURL.trim();
      const trimmedKey = apiKey.trim();

      // A signed-in subscription provider has no key to test or store: the
      // tokens are already in the home-level auth store, and config load
      // projects that store into the provider catalog. Only the selection is
      // persisted here — the same two files /model writes when switching.
      if (oauth !== undefined) {
        setPhase("saving");
        const base = existing ?? { providers: {} };
        await saveGlobalSettings(settingsPath, {
          ...base,
          defaultProvider: oauth.providerName,
        });
        await saveLocalSettings(localSettingsPath(config.cwd), {
          provider: oauth.providerName,
          model: model.trim(),
        });
        return;
      }

      // Fail fast on a bad base URL/key here rather than mid-conversation
      // during the first real stream request. The operator can bypass the
      // check (Ctrl+S) for providers that don't expose /models. Anthropic
      // Messages endpoints are exempt: the probe is an OpenAI-compatible GET
      // /models with a bearer token, which that surface always rejects.
      if (!skipValidation && preset?.anthropic !== true) {
        const check = await validateProviderConnection({
          baseURL: trimmedBaseURL,
          apiKey: trimmedKey.length > 0 ? trimmedKey : undefined,
        });
        if (!check.ok) {
          throw new Error(check.error);
        }
      }

      setPhase("saving");
      const selectedModel = model.trim();
      // A picked provider seeds its whole catalog so /model has more than the
      // one model chosen here; the protocol flags cannot be expressed by the
      // four form values and come from the catalog entry.
      const models =
        preset !== undefined && preset.models.includes(selectedModel)
          ? [...preset.models]
          : [selectedModel];
      const newProvider = {
        baseURL: trimmedBaseURL,
        models,
        defaultModel: selectedModel,
        ...(trimmedKey.length > 0 ? { apiKey: trimmedKey } : { keyless: true }),
        ...(preset?.anthropic === true ? { anthropic: true } : {}),
        ...(preset?.opencodeGo === true ? { opencodeGo: true } : {}),
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

  // An explicit globalSettingsPath tells loadConfig it is on a controlled
  // settings source and suppresses the home-level OAuth profile projection.
  // Passing the default path would therefore hide a provider the operator just
  // signed into, so it is only forwarded when it really is an override.
  const overridesSettingsPath = settingsPath !== globalSettingsPath();
  const newConfig = await loadConfig(
    argv,
    overridesSettingsPath ? { globalSettingsPath: settingsPath } : {},
  );
  return runTUI(newConfig);
}
