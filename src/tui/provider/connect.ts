/**
 * Inline connect flow for the model picker's Alt+A add-provider selector.
 * Extracted wiring around provider-setup's existing full-screen setup surface
 * (key entry + OAuth login, with its timeout/cancel/failure handling already
 * implemented there) — reused via `initialProviderId`, not reimplemented.
 */

import type { Settings } from "../../config/settings.js";
import { getTelemetry } from "../../telemetry/singleton.js";
import {
  authProviderFromConnectId,
  captureAuthSuccess,
} from "../chrome-state.js";
import { runProviderSetup } from "./setup.js";
import type { ProviderSetupConfig } from "./types.js";
import {
  buildProviderSubmitHandler,
  type PersistProviderSettings,
} from "./submit.js";

export interface ConnectProviderInput {
  readonly providerId: string;
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
    input.persistSettings,
  );

  const submitted = await runProviderSetup({
    showTelemetryNotice: false,
    initialProviderId: input.providerId,
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
      // unverified marking) live in the one funnel every provider-setup exit
      // path shares — see buildProviderSubmitHandler.
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
  // Login-completion site: exactly one enum-only event per completed /connect
  // sign-in. Cancelled flows return above and failed submits never set
  // connected, so neither can emit. The setup choice id maps to the enum with
  // other-fallback — free-text names never leave the process.
  captureAuthSuccess(getTelemetry(), {
    connected: result.connected,
    authProvider: authProviderFromConnectId(input.providerId),
  });
  return result;
}
