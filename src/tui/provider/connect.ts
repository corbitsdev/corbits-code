/**
 * Inline connect flow for the model picker's Alt+A add-provider selector:
 * wiring around the full-screen setup surface, reused via
 * `initialProviderId` instead of reimplemented.
 */

import type { Settings } from "../../config/settings.js";
import { getTelemetry } from "../../telemetry/singleton.js";
import { runProviderSetup } from "./setup.js";
import type { ProviderSetupConfig } from "./types.js";
import {
  buildProviderSubmitHandler,
  type PersistProviderSettings,
} from "./submit.js";

export interface ConnectProviderInput {
  readonly providerId: string;
  /** Prefill the OAuth account-name step with the profile slug being re-keyed. */
  readonly initialOAuthProfile?: string;
  readonly settingsPath: string;
  /** Project-local selection file, or null when it aliases global settings. */
  readonly localSettingsPath: string | null;
  readonly existing: Settings | null;
  readonly persistSettings?: PersistProviderSettings;
  readonly createRenderer?: ProviderSetupConfig["createRenderer"];
  readonly startLogin?: ProviderSetupConfig["startLogin"];
  readonly discoverOllamaModels?: ProviderSetupConfig["discoverOllamaModels"];
  readonly prefetchGoModels?: ProviderSetupConfig["prefetchGoModels"];
}

export interface ConnectProviderResult {
  readonly connected: boolean;
  /** Settings/catalog provider name to select once connected (may differ
   * from `providerId` for OAuth). */
  readonly providerName?: string;
  readonly model?: string;
}

/**
 * Run the setup surface pinned to one provider and persist the result the
 * same way first-run onboarding does. Cancelling (Ctrl+C/Ctrl+D) resolves
 * `connected: false` and writes nothing.
 */
export async function connectProviderInline(
  input: ConnectProviderInput,
): Promise<ConnectProviderResult> {
  let result: ConnectProviderResult = { connected: false };
  const submitProvider = buildProviderSubmitHandler(
    input.settingsPath,
    input.existing,
    input.localSettingsPath,
    input.persistSettings,
    getTelemetry(),
  );

  const submitted = await runProviderSetup({
    showTelemetryNotice: false,
    initialProviderId: input.providerId,
    ...(input.initialOAuthProfile !== undefined
      ? { initialOAuthProfile: input.initialOAuthProfile }
      : {}),
    existingProviderNames: Object.keys(input.existing?.providers ?? {}),
    ...(input.createRenderer !== undefined
      ? { createRenderer: input.createRenderer }
      : {}),
    ...(input.startLogin !== undefined ? { startLogin: input.startLogin } : {}),
    ...(input.discoverOllamaModels !== undefined
      ? { discoverOllamaModels: input.discoverOllamaModels }
      : {}),
    ...(input.prefetchGoModels !== undefined
      ? { prefetchGoModels: input.prefetchGoModels }
      : {}),
    onSubmit: async (values, setPhase, opts) => {
      // Persistence and validation (empty-key rejection, connection test,
      // unverified marking) live in the one shared exit funnel.
      await submitProvider(values, setPhase, opts);
      result =
        opts.oauth !== undefined
          ? {
              connected: true,
              providerName: opts.oauth.providerName,
              model: values.model.trim(),
            }
          : {
              connected: true,
              providerName: values.name.trim(),
              model: values.model.trim(),
            };
    },
  });

  if (!submitted) return { connected: false };
  return result;
}
