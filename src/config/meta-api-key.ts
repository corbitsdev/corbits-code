import { META_BASE_URL, META_DEFAULT_MODELS } from "../auth/meta/constants.js";
import { META_API_KEY_PROVIDER_ID } from "../../packages/first-class-providers/src/index.js";
import {
  isMetaProviderName,
  metaProfileFromProviderName,
} from "./meta-providers.js";
import type { ModelRef, ProviderSettings, Settings } from "./settings.js";

export function isMetaApiKeyProviderName(name: string): boolean {
  return (
    name === META_API_KEY_PROVIDER_ID ||
    name.startsWith(`${META_API_KEY_PROVIDER_ID}/`)
  );
}

function hasApiKey(
  provider: Pick<ProviderSettings, "apiKey"> | undefined,
): boolean {
  return typeof provider?.apiKey === "string" && provider.apiKey.length > 0;
}

function nextFreeMetaApiName(
  slug: string,
  providers: Readonly<Record<string, ProviderSettings>>,
): string {
  let name = `${META_API_KEY_PROVIDER_ID}/${slug}`;
  let n = 2;
  while (providers[name] !== undefined) {
    name = `${META_API_KEY_PROVIDER_ID}/${slug}-${String(n)}`;
    n += 1;
  }
  return name;
}

function oauthPlaceholder(provider: ProviderSettings): ProviderSettings {
  const models =
    provider.models.length > 0 ? provider.models : [...META_DEFAULT_MODELS];
  const defaultModel = provider.defaultModel ?? models[0];
  return {
    baseURL: META_BASE_URL,
    models,
    ...(defaultModel !== undefined ? { defaultModel } : {}),
  };
}

function remapProviderRefs(
  refs: readonly ModelRef[] | undefined,
  from: string,
  to: string,
): ModelRef[] | undefined {
  if (refs === undefined) return undefined;
  return refs.map((ref) =>
    ref.provider === from ? { provider: to, model: ref.model } : ref,
  );
}

/**
 * Move a hand-saved Meta API key off `meta/<slug>` when that slug is an OAuth
 * profile. The key keeps its secret under `meta-api/<slug>`; `meta/<slug>`
 * becomes a credential-less OAuth placeholder.
 */
export function separateCollidingMetaApiKeys(
  settings: Settings | null,
  oauthSlugs: readonly string[],
): { settings: Settings | null; changed: boolean } {
  if (settings === null || oauthSlugs.length === 0) {
    return { settings, changed: false };
  }
  const slugs = new Set(oauthSlugs);
  let providers: Record<string, ProviderSettings> = {
    ...settings.providers,
  };
  let defaultProvider = settings.defaultProvider;
  let recentModels = settings.recentModels;
  let favoriteModels = settings.favoriteModels;
  let changed = false;
  for (const [name, provider] of Object.entries(settings.providers)) {
    if (!isMetaProviderName(name) || !hasApiKey(provider)) continue;
    const slug = metaProfileFromProviderName(name);
    if (slug === undefined || slug.length === 0 || !slugs.has(slug)) continue;
    const relocated = nextFreeMetaApiName(slug, providers);
    const without: Record<string, ProviderSettings> = {};
    for (const [key, value] of Object.entries(providers)) {
      if (key !== name) without[key] = value;
    }
    without[relocated] = provider;
    without[name] = oauthPlaceholder(provider);
    providers = without;
    if (defaultProvider === name) defaultProvider = relocated;
    recentModels = remapProviderRefs(recentModels, name, relocated);
    favoriteModels = remapProviderRefs(favoriteModels, name, relocated);
    changed = true;
  }
  if (!changed) return { settings, changed: false };
  return {
    settings: {
      ...settings,
      ...(defaultProvider !== undefined ? { defaultProvider } : {}),
      providers,
      ...(recentModels !== undefined ? { recentModels } : {}),
      ...(favoriteModels !== undefined ? { favoriteModels } : {}),
    },
    changed: true,
  };
}

/**
 * OAuth save for `oauthName`. An existing API key at that name is moved aside;
 * the placeholder written for OAuth never carries the key.
 */
export function assignMetaOAuthProviderRow(
  settings: Settings,
  oauthName: string,
  placeholder: ProviderSettings,
): Settings {
  const existing = settings.providers[oauthName];
  if (
    existing === undefined ||
    !isMetaProviderName(oauthName) ||
    !hasApiKey(existing)
  ) {
    return {
      ...settings,
      defaultProvider: oauthName,
      providers: { ...settings.providers, [oauthName]: placeholder },
    };
  }
  const slug = metaProfileFromProviderName(oauthName) ?? "default";
  const relocated = nextFreeMetaApiName(slug, settings.providers);
  const recentModels = remapProviderRefs(
    settings.recentModels,
    oauthName,
    relocated,
  );
  const favoriteModels = remapProviderRefs(
    settings.favoriteModels,
    oauthName,
    relocated,
  );
  return {
    ...settings,
    defaultProvider: oauthName,
    providers: {
      ...settings.providers,
      [relocated]: existing,
      [oauthName]: placeholder,
    },
    ...(recentModels !== undefined ? { recentModels } : {}),
    ...(favoriteModels !== undefined ? { favoriteModels } : {}),
  };
}
