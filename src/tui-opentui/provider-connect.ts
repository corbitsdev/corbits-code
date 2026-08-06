/**
 * Inline "connect →" flow for the model picker's not-connected providers.
 * Extracted wiring around provider-setup's existing full-screen setup surface
 * (key entry + OAuth login, with its timeout/cancel/failure handling already
 * implemented there) — reused via `initialProviderId`, not reimplemented.
 */

import {
  mergeProviderIntoSettings,
  saveGlobalSettings,
  saveLocalSettings,
  type Settings,
} from "../config/settings.js"
import { validateProviderConnection } from "../provider/validate-connection.js"
import { runProviderSetup, type ProviderSetupConfig } from "./provider-setup.js"

export type ConnectProviderInput = {
  readonly providerId: string
  readonly settingsPath: string
  readonly localSettingsPath: string
  readonly cwd: string
  readonly existing: Settings | null
  readonly createRenderer?: ProviderSetupConfig["createRenderer"]
  readonly startLogin?: ProviderSetupConfig["startLogin"]
}

export type ConnectProviderResult = {
  readonly connected: boolean
  /** Settings/catalog provider name to select once connected (may differ from `providerId` for OAuth). */
  readonly providerName?: string
  readonly model?: string
}

/**
 * Runs the extracted setup surface pinned to one provider and persists the
 * result exactly the way first-run onboarding does. Resolves `connected:
 * false` on cancel (Ctrl+C/Ctrl+D) without writing anything.
 */
export async function connectProviderInline(
  input: ConnectProviderInput,
): Promise<ConnectProviderResult> {
  let result: ConnectProviderResult = { connected: false }

  const submitted = await runProviderSetup({
    showTelemetryNotice: false,
    initialProviderId: input.providerId,
    ...(input.createRenderer !== undefined ? { createRenderer: input.createRenderer } : {}),
    ...(input.startLogin !== undefined ? { startLogin: input.startLogin } : {}),
    onSubmit: async (values, setPhase, { skipValidation, preset, oauth }) => {
      const { name, baseURL, apiKey, model } = values
      const providerName = name.trim()
      const trimmedBaseURL = baseURL.trim()
      const trimmedKey = apiKey.trim()

      if (oauth !== undefined) {
        setPhase("saving")
        const base = input.existing ?? { providers: {} }
        await saveGlobalSettings(input.settingsPath, {
          ...base,
          defaultProvider: oauth.providerName,
        })
        await saveLocalSettings(input.localSettingsPath, {
          provider: oauth.providerName,
          model: model.trim(),
        })
        result = { connected: true, providerName: oauth.providerName, model: model.trim() }
        return
      }

      if (!skipValidation && preset?.anthropic !== true) {
        const check = await validateProviderConnection({
          baseURL: trimmedBaseURL,
          apiKey: trimmedKey.length > 0 ? trimmedKey : undefined,
        })
        if (!check.ok) throw new Error(check.error)
      }

      setPhase("saving")
      const selectedModel = model.trim()
      const models =
        preset !== undefined && preset.models.includes(selectedModel)
          ? [...preset.models]
          : [selectedModel]
      const newProvider = {
        baseURL: trimmedBaseURL,
        models,
        defaultModel: selectedModel,
        ...(trimmedKey.length > 0 ? { apiKey: trimmedKey } : { keyless: true }),
        ...(preset?.anthropic === true ? { anthropic: true } : {}),
        ...(preset?.opencodeGo === true ? { opencodeGo: true } : {}),
      }
      const merged = mergeProviderIntoSettings(input.existing, providerName, newProvider)
      await saveGlobalSettings(input.settingsPath, merged)
      result = { connected: true, providerName, model: selectedModel }
    },
  })

  if (!submitted) return { connected: false }
  return result
}
