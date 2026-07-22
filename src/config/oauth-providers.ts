import type { ProviderCatalogEntry } from "./index.js";
import type { ProviderSettings } from "./settings.js";

// OAuth profiles surface through the same provider catalog as API-key
// providers so the /agent picker lists them inline. Each profile becomes a
// provider named "<prefix><profile>"; the prefix namespaces them and signals
// the OAuth origin in the UI without special-casing the picker. Codex and xAI
// share this projection; only the prefix, endpoint, model list, and catalog
// markers differ.

type OAuthProfileLike = {
  name: string;
  tokens: { access: string };
};

export type OAuthProviderProjection<P extends OAuthProfileLike> = {
  providerName: (profile: string) => string;
  isProviderName: (name: string) => boolean;
  profileFromProviderName: (name: string) => string | undefined;
  providersAsSettings: (profiles: readonly P[]) => Record<string, ProviderSettings>;
  profilesToCatalogEntries: (profiles: readonly P[]) => ProviderCatalogEntry[];
};

export type OAuthProviderProjectionOptions<P extends OAuthProfileLike> = {
  // Provider namespace including the trailing slash (e.g. "codex/").
  prefix: string;
  baseURL: string;
  // Non-empty: the first entry doubles as the default model.
  defaultModels: readonly [string, ...string[]];
  // Provider-specific catalog fields (profile marker, account id, …) merged
  // into each catalog entry so the runtime can route it to the right adapter.
  catalogExtras: (profile: P) => Partial<ProviderCatalogEntry>;
};

export function createOAuthProviderProjection<P extends OAuthProfileLike>(
  options: OAuthProviderProjectionOptions<P>,
): OAuthProviderProjection<P> {
  const providerName = (profile: string): string => `${options.prefix}${profile}`;
  const isProviderName = (name: string): boolean => name.startsWith(options.prefix);

  return {
    providerName,
    isProviderName,
    // The profile name embedded in a "<prefix><profile>" provider name, or
    // undefined if the name is not this provider's.
    profileFromProviderName(name: string): string | undefined {
      return isProviderName(name) ? name.slice(options.prefix.length) : undefined;
    },
    // Project profiles into synthetic ProviderSettings so resolveProvider can
    // treat a selected "<prefix><profile>" exactly like any configured
    // provider. The apiKey seeds the stored access token; the send path
    // refreshes it before use, so a stale seed never reaches the wire.
    providersAsSettings(profiles: readonly P[]): Record<string, ProviderSettings> {
      const entries: Record<string, ProviderSettings> = {};
      for (const profile of profiles) {
        entries[providerName(profile.name)] = {
          name: providerName(profile.name),
          baseURL: options.baseURL,
          apiKey: profile.tokens.access,
          models: [...options.defaultModels],
          defaultModel: options.defaultModels[0],
        };
      }
      return entries;
    },
    // Build provider catalog entries. Unlike the settings projection above,
    // these carry the provider's marker fields (via catalogExtras) so the
    // runtime can route them to the matching adapter and headers.
    profilesToCatalogEntries(profiles: readonly P[]): ProviderCatalogEntry[] {
      return profiles.map((profile) => ({
        name: providerName(profile.name),
        baseURL: options.baseURL,
        apiKey: profile.tokens.access,
        models: [...options.defaultModels],
        defaultModel: options.defaultModels[0],
        ...options.catalogExtras(profile),
      }));
    },
  };
}
