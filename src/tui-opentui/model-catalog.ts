/**
 * Provider/model catalog → model picker options for OpenTUI product host.
 *
 * Pure: maps config.providers (record or array) into `{ id, label }[]` for
 * openModelPickerOverlay / ProductHostConfig.models. No settings import.
 *
 * Identity is `provider:model` (matches runner active-model string).
 */

/** Picker row — same shape as ProductHostModelOption. */
export type ModelCatalogOption = {
  readonly id: string
  readonly label: string
}

/** Array-shaped provider (ModelPickerProvider / catalog entry subset). */
export type ModelCatalogProvider = {
  readonly name: string
  readonly models: readonly string[]
  /** Display name for the provider bucket (falls back to `name`). */
  readonly label?: string
}

/** settings.providers value subset — models list only. */
export type ModelCatalogProviderSettings = {
  readonly models?: readonly string[]
  readonly name?: string
  readonly label?: string
}

export type ModelCatalogProvidersInput =
  | readonly ModelCatalogProvider[]
  | Readonly<Record<string, ModelCatalogProviderSettings>>

/**
 * Flatten providers into picker options.
 *
 * - Array: each `{ name, models, label? }` expands one row per model.
 * - Record: keys are provider names; values supply `models` (+ optional label).
 *
 * Empty / missing model lists are skipped. Stable order: provider order then
 * model order within each provider. Dedupes by id.
 */
export function buildModelCatalog(
  providers: ModelCatalogProvidersInput,
): ModelCatalogOption[] {
  const entries = normalizeProviders(providers)
  const seen = new Set<string>()
  const out: ModelCatalogOption[] = []

  for (const p of entries) {
    const providerLabel =
      p.label !== undefined && p.label.trim().length > 0 ? p.label.trim() : p.name
    for (const model of p.models) {
      const m = model.trim()
      if (m.length === 0) continue
      const id = modelOptionId(p.name, m)
      if (seen.has(id)) continue
      seen.add(id)
      out.push({
        id,
        label: `${providerLabel} / ${m}`,
      })
    }
  }

  return out
}

/** Stable id for a provider+model pair (`provider:model`). */
export function modelOptionId(provider: string, model: string): string {
  return `${provider}:${model}`
}

function normalizeProviders(
  providers: ModelCatalogProvidersInput,
): ModelCatalogProvider[] {
  if (Array.isArray(providers)) {
    return providers
      .filter((p) => typeof p.name === "string" && p.name.length > 0)
      .map((p) => ({
        name: p.name,
        models: p.models ?? [],
        ...(p.label !== undefined ? { label: p.label } : {}),
      }))
  }

  const record = providers as Readonly<Record<string, ModelCatalogProviderSettings>>
  return Object.entries(record).map(([name, settings]) => {
    const label = settings.label ?? settings.name
    return {
      name,
      models: settings.models ?? [],
      ...(label !== undefined ? { label } : {}),
    }
  })
}
