import { XAI_BASE_URL, XAI_DEFAULT_MODELS } from "../auth/xai/constants.js";
import type { XaiProfile } from "../auth/xai/store.js";
import type { ProviderCatalogEntry } from "./index.js";
import type { ProviderSettings } from "./settings.js";

export const XAI_PROVIDER_PREFIX = "xai/";

export function xaiProviderName(profile: string): string {
  return `${XAI_PROVIDER_PREFIX}${profile}`;
}

export function isXaiProviderName(name: string): boolean {
  return name.startsWith(XAI_PROVIDER_PREFIX);
}

export function xaiProfileFromProviderName(name: string): string | undefined {
  return isXaiProviderName(name) ? name.slice(XAI_PROVIDER_PREFIX.length) : undefined;
}

export function xaiProvidersAsSettings(profiles: readonly XaiProfile[]): Record<string, ProviderSettings> {
  const entries: Record<string, ProviderSettings> = {};
  for (const profile of profiles) {
    entries[xaiProviderName(profile.name)] = {
      name: xaiProviderName(profile.name),
      baseURL: XAI_BASE_URL,
      apiKey: profile.tokens.access,
      models: [...XAI_DEFAULT_MODELS],
      defaultModel: XAI_DEFAULT_MODELS[0],
    };
  }
  return entries;
}

export function xaiProfilesToCatalogEntries(profiles: readonly XaiProfile[]): ProviderCatalogEntry[] {
  return profiles.map((profile) => ({
    name: xaiProviderName(profile.name),
    baseURL: XAI_BASE_URL,
    apiKey: profile.tokens.access,
    models: [...XAI_DEFAULT_MODELS],
    defaultModel: XAI_DEFAULT_MODELS[0],
    xaiProfile: profile.name,
  }));
}
