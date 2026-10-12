import {
  META_API_KEY_LIFETIME_MS,
  META_BASE_URL,
  META_DEFAULT_MODELS,
} from "@corbits/meta-provider";

export { META_BASE_URL, META_DEFAULT_MODELS, META_API_KEY_LIFETIME_MS };

// Minted keys last ~24h; skew stays inside that to avoid an expiry race.
export const META_REFRESH_SKEW_MS = 5 * 60 * 1000;
