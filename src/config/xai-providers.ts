import { XAI_BASE_URL, XAI_DEFAULT_MODELS } from "../adapters/auth/xai/constants.js";
import type { XaiProfile } from "../adapters/auth/xai/store.js";
import { createOAuthProviderProjection } from "./oauth-providers.js";

export const XAI_PROVIDER_PREFIX = "xai/";

const projection = createOAuthProviderProjection<XaiProfile>({
  prefix: XAI_PROVIDER_PREFIX,
  baseURL: XAI_BASE_URL,
  defaultModels: XAI_DEFAULT_MODELS,
  catalogExtras: (profile) => ({ xaiProfile: profile.name }),
});

export const xaiProviderName = projection.providerName;
export const isXaiProviderName = projection.isProviderName;
export const xaiProfileFromProviderName = projection.profileFromProviderName;
export const xaiProvidersAsSettings = projection.providersAsSettings;
export const xaiProfilesToCatalogEntries = projection.profilesToCatalogEntries;
