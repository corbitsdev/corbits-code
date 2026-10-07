import { type } from "arktype";

import {
  isOllamaProviderId,
  normalizeOllamaRootURL,
  ollamaOpenAIBaseURL,
} from "../../provider/ollama.js";
import { validateProviderConnection } from "../../provider/validate-connection.js";
import {
  mergeProviderIntoSettings,
  saveGlobalSettings,
  saveLocalSettings,
  type ProviderSettings,
  type Settings,
} from "../../config/settings.js";
import { COMMAND_NAME } from "../../branding.js";
import {
  OAuthProviderScopeError,
  checkOAuthProviderScope,
  isBlockingOAuthScopeCheckResult,
} from "../../auth/oauth-scope-check.js";
import type { ProviderSetupSubmit } from "./types.js";
import { NOOP_TELEMETRY, type Telemetry } from "../../telemetry/index.js";
import { classifyAuthProvider } from "../../telemetry/classify.js";
import { captureAuthSuccess } from "../../telemetry/product-events.js";
import {
  isReasoningEffort,
  normalizeProviderEfforts,
} from "../../provider/reasoning-effort.js";
import { ProviderInferenceOptionsSchema } from "../../config/provider-inference-options.js";

const CustomInferenceInputsSchema = type({
  contextWindow: "string",
  maxTokens: "string",
  temperature: "string",
  topP: "string",
});

function parseCustomInferenceOptions(
  values: unknown,
): typeof ProviderInferenceOptionsSchema.infer {
  const inputs = CustomInferenceInputsSchema(values);
  if (inputs instanceof type.errors) {
    throw new Error(`Invalid custom provider options: ${inputs.summary}`);
  }
  const numbers: Record<string, number> = {};
  for (const [field, raw] of Object.entries(inputs)) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) numbers[field] = Number(trimmed);
  }
  const options = ProviderInferenceOptionsSchema(numbers);
  if (options instanceof type.errors) {
    throw new Error(`Invalid custom provider options: ${options.summary}`);
  }
  return options;
}

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
export type PersistProviderSettings = (
  apply: (base: Settings) => Settings,
) => Promise<Settings>;

export function buildProviderSubmitHandler(
  settingsPath: string,
  existing: Settings | null,
  localSettingsFile: string | null,
  persistSettings: PersistProviderSettings = async (apply) => {
    const next = apply(existing ?? { providers: {} });
    await saveGlobalSettings(settingsPath, next);
    return next;
  },
  telemetry: Telemetry = NOOP_TELEMETRY,
): ProviderSetupSubmit {
  return async (values, setPhase, { skipValidation, preset, oauth }) => {
    const { name, baseURL, apiKey, model } = values;
    const providerName = name.trim();
    const trimmedBaseURL = baseURL.trim();
    const trimmedKey = apiKey.trim();
    const selectedModel = model.trim();

    // Preset/OAuth paths never expose these fields, so stale drafts must not
    // affect their credentials or persist hidden custom configuration.
    const inferenceOptions =
      preset === undefined && oauth === undefined
        ? parseCustomInferenceOptions({
            contextWindow: values.contextWindow,
            maxTokens: values.maxTokens,
            temperature: values.temperature,
            topP: values.topP,
          })
        : {};
    const isOllama = preset !== undefined && isOllamaProviderId(preset.id);
    const effectiveApiKey =
      isOllama || trimmedKey.length === 0 ? undefined : trimmedKey;
    const persistedBaseURL = isOllama
      ? normalizeOllamaRootURL(trimmedBaseURL)
      : trimmedBaseURL;
    const effortLevels = normalizeProviderEfforts(values.reasoningEfforts);
    const trimmedDefaultEffort = values.defaultReasoningEffort.trim();
    if (preset === undefined && oauth === undefined) {
      if (effortLevels.length === 0) {
        throw new Error("Enable at least one reasoning effort.");
      }
      if (
        !isReasoningEffort(trimmedDefaultEffort) ||
        !effortLevels.includes(trimmedDefaultEffort)
      ) {
        throw new Error(
          "Choose a default reasoning effort from the enabled levels.",
        );
      }
    }

    // OAuth credentials stay staged until setup validation authorizes durable
    // persistence. Definitive API-scope or credential failures block the save;
    // inconclusive probe failures do not. Once committed to the home-level auth
    // store, config load projects it into the provider catalog, so only
    // non-secret provider/model metadata is persisted globally.
    if (oauth !== undefined) {
      if (!skipValidation) {
        const scopeCheck = await checkOAuthProviderScope(
          oauth.kind,
          oauth.tokens,
          COMMAND_NAME,
        );
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
      await persistConnectedSelection(
        localSettingsFile,
        oauth.providerName,
        selectedModel,
      );
      captureAuthSuccess(telemetry, classifyAuthProvider(oauth.kind));
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
        baseURL: isOllama
          ? ollamaOpenAIBaseURL(persistedBaseURL)
          : persistedBaseURL,
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
    // The operator's enabled levels and picked default flow to the catalog so
    // /model cycling and session resolution use the operator set. Only the
    // custom path carries these values (presets/OAuth never set them).
    const newProvider: ProviderSettings = {
      baseURL: persistedBaseURL,
      models,
      defaultModel: selectedModel,
      ...(effectiveApiKey !== undefined
        ? { apiKey: effectiveApiKey }
        : { keyless: true }),
      ...(preset?.anthropic === true ? { anthropic: true } : {}),
      ...(preset?.opencodeGo === true ? { opencodeGo: true } : {}),
      ...(preset === undefined && effortLevels.length > 0
        ? { reasoningEfforts: effortLevels }
        : {}),
      ...(preset === undefined && isReasoningEffort(trimmedDefaultEffort)
        ? { defaultReasoningEffort: trimmedDefaultEffort }
        : {}),
      ...inferenceOptions,
      // "Save anyway" (Ctrl+S) persists a credential the connection test
      // never passed. Mark it so the running session can warn on first use
      // instead of surfacing a bare adapter error.
      ...(skipValidation ? { verified: false } : {}),
    };
    // Merge new provider with any pre-existing ones in one write — the form
    // stays open until saveGlobalSettings resolves, so the user sees
    // confirmation before the screen clears. Full-spread merge so
    // plugins/pluginPaths/sessionMode/shell/tools survive re-onboarding.
    await persistSettings((base) =>
      mergeProviderIntoSettings(base, providerName, newProvider),
    );
    // Same project-local selection contract as OAuth: credentials stay in
    // global storage; the local file is selection only so a restart in this
    // repo resolves to the provider just connected.
    await persistConnectedSelection(
      localSettingsFile,
      providerName,
      selectedModel,
    );
    captureAuthSuccess(
      telemetry,
      classifyAuthProvider(preset?.anthropic === true ? "anthropic" : "other"),
    );
  };
}
