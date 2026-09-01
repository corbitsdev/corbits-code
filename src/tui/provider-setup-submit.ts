import {
  OAuthProviderScopeError,
  checkOAuthProviderScope,
  isBlockingOAuthScopeCheckResult,
} from "../auth/oauth-scope-check.js";
import {
  mergeProviderIntoSettings,
  saveGlobalSettings,
  saveLocalSettings,
  type Settings,
} from "../config/settings.js";
import {
  isOllamaProviderId,
  normalizeOllamaRootURL,
  ollamaOpenAIBaseURL,
} from "../provider/ollama.js";
import { validateProviderConnection } from "../provider/validate-connection.js";
import type { ProviderSetupSubmit } from "./provider-setup.js";

/**
 * Persist the project-local provider/model selection after a successful
 * connect. Shared by OAuth and API-key paths so both leave the same two
 * files `/model` would write on a switch: global credentials/catalog and
 * local selection only (never secrets).
 */
export async function persistConnectedSelection(
  localSettingsFile: string | null,
  provider: string,
  model: string,
): Promise<void> {
  if (localSettingsFile === null) return;
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
export type PersistProviderSettings = (apply: (base: Settings) => Settings) => Promise<Settings>;

export function buildProviderSubmitHandler(
  settingsPath: string,
  existing: Settings | null,
  localSettingsFile: string | null,
  persistSettings: PersistProviderSettings = async (apply) => {
    const next = apply(existing ?? { providers: {} });
    await saveGlobalSettings(settingsPath, next);
    return next;
  },
): ProviderSetupSubmit {
  return async (values, setPhase, { skipValidation, preset, oauth }) => {
    const { name, baseURL, apiKey, model } = values;
    const providerName = name.trim();
    const trimmedBaseURL = baseURL.trim();
    const trimmedKey = apiKey.trim();
    const selectedModel = model.trim();
    const isOllama = preset !== undefined && isOllamaProviderId(preset.id);
    const effectiveApiKey = isOllama || trimmedKey.length === 0 ? undefined : trimmedKey;
    const persistedBaseURL = isOllama ? normalizeOllamaRootURL(trimmedBaseURL) : trimmedBaseURL;

    // OAuth credentials stay staged until setup validation authorizes durable
    // persistence. Definitive API-scope or credential failures block the save;
    // inconclusive probe failures do not. Once committed to the home-level auth
    // store, config load projects it into the provider catalog, so only
    // non-secret provider/model metadata is persisted globally.
    if (oauth !== undefined) {
      if (!skipValidation) {
        const scopeCheck = await checkOAuthProviderScope(oauth.kind, oauth.tokens);
        if (isBlockingOAuthScopeCheckResult(scopeCheck)) {
          throw new OAuthProviderScopeError(scopeCheck.message);
        }
      }
      setPhase("saving");
      await oauth.commit();
      await persistSettings((base) => ({
        ...base,
        defaultProvider: oauth.providerName,
        providers: {
          ...base.providers,
          [oauth.providerName]: {
            baseURL: trimmedBaseURL,
            models: [selectedModel],
            defaultModel: selectedModel,
          },
        },
      }));
      await persistConnectedSelection(localSettingsFile, oauth.providerName, selectedModel);
      return;
    }

    // A known preset (anything but the custom/manual endpoint) always speaks
    // to a real provider that requires a key; only the manual path is
    // genuinely keyless-capable (e.g. a local OpenAI-compatible runtime).
    // Reject an empty key here rather than silently downgrading it to
    // `keyless: true` and letting resolveProvider skip the missing-key check
    // entirely.
    if (preset !== undefined && !isOllama && trimmedKey.length === 0) {
      throw new Error(`${providerName || preset.id} requires an API key.`);
    }

    // Fail fast on a bad base URL/key here rather than mid-conversation
    // during the first real stream request. The operator can bypass the
    // check (Ctrl+S) for providers that don't expose /models. Anthropic
    // Messages endpoints are exempt: the probe is an OpenAI-compatible GET
    // /models with a bearer token, which that surface always rejects.
    if (!skipValidation && preset?.anthropic !== true) {
      const check = await validateProviderConnection({
        baseURL: isOllama ? ollamaOpenAIBaseURL(persistedBaseURL) : persistedBaseURL,
        apiKey: effectiveApiKey,
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
      baseURL: persistedBaseURL,
      models,
      defaultModel: selectedModel,
      ...(effectiveApiKey !== undefined ? { apiKey: effectiveApiKey } : { keyless: true }),
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
    await persistSettings((base) => mergeProviderIntoSettings(base, providerName, newProvider));
    // Same project-local selection contract as OAuth: credentials stay in
    // global storage; the local file is selection only so a restart in this
    // repo resolves to the provider just connected.
    await persistConnectedSelection(localSettingsFile, providerName, selectedModel);
  };
}
