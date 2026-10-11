import { META_BASE_URL, META_DEFAULT_MODELS } from "../auth/meta/constants.js";
import type { MetaProfile } from "../auth/meta/store.js";
import { createOAuthProviderProjection } from "./oauth-providers.js";

export const META_PROVIDER_PREFIX = "meta/";

const projection = createOAuthProviderProjection<MetaProfile>({
  prefix: META_PROVIDER_PREFIX,
  baseURL: META_BASE_URL,
  defaultModels: META_DEFAULT_MODELS,
  catalogExtras: (profile) => ({ metaProfile: profile.name }),
});

export const metaProviderName = projection.providerName;
export const isMetaProviderName = projection.isProviderName;
export const metaProfileFromProviderName = projection.profileFromProviderName;
export const metaProvidersAsSettings = projection.providersAsSettings;
export const metaProfilesToCatalogEntries = projection.profilesToCatalogEntries;
