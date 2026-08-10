import {
  mergeProviderIntoSettings,
  saveGlobalSettings,
  saveLocalSettings,
  type Settings,
} from "../config/settings.js";
import { validateProviderConnection } from "../provider/validate-connection.js";
import type { ProviderSetupSubmit } from "./provider-setup.js";

/**
 * Persist the project-local provider/model selection after a successful
 * connect. Shared by OAuth and API-key paths so both leave the same two
 * files `/model` would write on a switch: global credentials/catalog and
 * local selection only (never secrets).
 */
export async function persistConnectedSelection(
  localSettingsFile: string,
  provider: string,
  model: string,
): Promise<void> {
  await saveLocalSettings(localSettingsFile, {
    provider,
    model,
  });
}

/**
 * The single write path every provider-setup exit takes, shared by first-run
 * onboarding and mid-session "connect a new provider" so a credential is
 * validated (or explicitly marked unverified) the same way regardless of
 * where the form was opened from.
 *
 * `localSettingsFile` is the project-local selection path (wired through from
 * callers that already own it — never re-derived here so tests and the
 * mid-session connect path can pass an explicit file).
 */
export function buildProviderSubmitHandler(
  settingsPath: string,
  existing: Settings | null,
  localSettingsFile: string,
): ProviderSetupSubmit {
  return async (values, setPhase, { skipValidation, preset, oauth }) => {
    const { name, baseURL, apiKey, model } = values;
    const providerName = name.trim();
    const trimmedBaseURL = baseURL.trim();
    const trimmedKey = apiKey.trim();
    const selectedModel = model.trim();

    // A signed-in subscription provider has no key to test or store: the
    // tokens are already in the home-level auth store, and config load
    // projects that store into the provider catalog. Only the selection is
    // persisted here — the same two files /model writes when switching.
    //
    // Unlike a pasted key, this credential was just issued by the real
    // provider's own OAuth server completing a PKCE round-trip, so the
    // "unverified" concept the API-key path uses doesn't apply the same way
    // — there is no separate probe step to skip. What a completed login
    // does not confirm is that the resulting token actually carries API
    // scope (vs. e.g. a chat-only subscription), which can still surface as
    // a first-send auth error; tracked separately rather than faked here
    // with a flag this path has no real signal for.
    if (oauth !== undefined) {
      setPhase("saving");
      const base = existing ?? { providers: {} };
      await saveGlobalSettings(settingsPath, {
        ...base,
        defaultProvider: oauth.providerName,
      });
      await persistConnectedSelection(localSettingsFile, oauth.providerName, selectedModel);
      return;
    }

    // A known preset (anything but the custom/manual endpoint) always speaks
    // to a real provider that requires a key; only the manual path is
    // genuinely keyless-capable (e.g. a local OpenAI-compatible runtime).
    // Reject an empty key here rather than silently downgrading it to
    // `keyless: true` and letting resolveProvider skip the missing-key check
    // entirely.
    if (preset !== undefined && trimmedKey.length === 0) {
      throw new Error(`${providerName || preset.id} requires an API key.`);
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
      // "Save anyway" (Ctrl+S) persists a credential the connection test
      // never passed. Mark it so the running session can warn on first use
      // instead of surfacing a bare adapter error.
      ...(skipValidation ? { verified: false } : {}),
    };
    // Merge new provider with any pre-existing ones. Single write — the form
    // stays open (phase label) until saveGlobalSettings resolves, so the user
    // sees confirmation before the screen is cleared. Full-spread merge so
    // plugins/pluginPaths/sessionMode/shell/tools survive re-onboarding.
    const merged = mergeProviderIntoSettings(existing, providerName, newProvider);
    await saveGlobalSettings(settingsPath, merged);
    // Same project-local selection contract as OAuth: credentials stay in
    // global storage; the local file is selection only so a restart in this
    // repo resolves to the provider just connected.
    await persistConnectedSelection(localSettingsFile, providerName, selectedModel);
  };
}
