/**
 * Inline connect flow for the model picker's Alt+A add-provider selector.
 * Extracted wiring around provider-setup's existing full-screen setup surface
 * (key entry + OAuth login, with its timeout/cancel/failure handling already
 * implemented there) — reused via `initialProviderId`, not reimplemented.
 */

import type { Settings } from "../config/settings.js";
import { buildProviderSubmitHandler } from "./provider-setup-submit.js";
import { runProviderSetup, type ProviderSetupConfig } from "./provider-setup.js";

export interface ConnectProviderInput {
  readonly providerId: string;
  readonly settingsPath: string;
  /** Project-local selection file, or null when it aliases global settings. */
  readonly localSettingsPath: string | null;
  readonly existing: Settings | null;
  readonly createRenderer?: ProviderSetupConfig["createRenderer"];
  readonly startLogin?: ProviderSetupConfig["startLogin"];
  readonly discoverOllamaModels?: ProviderSetupConfig["discoverOllamaModels"];
}

export interface ConnectProviderResult {
  readonly connected: boolean;
  /** Settings/catalog provider name to select once connected (may differ from `providerId` for OAuth). */
  readonly providerName?: string;
  readonly model?: string;
}

/**
 * Runs the extracted setup surface pinned to one provider and persists the
 * result exactly the way first-run onboarding does. Resolves `connected:
 * false` on cancel (Ctrl+C/Ctrl+D) without writing anything.
 */
export async function connectProviderInline(
  input: ConnectProviderInput,
): Promise<ConnectProviderResult> {
  let result: ConnectProviderResult = { connected: false };
  const submitProvider = buildProviderSubmitHandler(
    input.settingsPath,
    input.existing,
    input.localSettingsPath,
  );

  const submitted = await runProviderSetup({
    showTelemetryNotice: false,
    initialProviderId: input.providerId,
    existingProviderNames: Object.keys(input.existing?.providers ?? {}),
    ...(input.createRenderer !== undefined ? { createRenderer: input.createRenderer } : {}),
    ...(input.startLogin !== undefined ? { startLogin: input.startLogin } : {}),
    ...(input.discoverOllamaModels !== undefined
      ? { discoverOllamaModels: input.discoverOllamaModels }
      : {}),
    onSubmit: async (values, setPhase, opts) => {
      // Persistence and validation (empty-key rejection, connection test,
      // unverified marking) live in the one funnel every provider-setup exit
      // path shares — see buildProviderSubmitHandler.
      await submitProvider(values, setPhase, opts);
      result =
        opts.oauth !== undefined
          ? { connected: true, providerName: opts.oauth.providerName, model: values.model.trim() }
          : { connected: true, providerName: values.name.trim(), model: values.model.trim() };
    },
  });

  if (!submitted) return { connected: false };
  return result;
}
