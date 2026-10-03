import {
  META_API_KEY_LIFETIME_MS,
  META_BASE_URL,
  META_DEFAULT_MODELS,
} from "@corbits/meta-provider";

export { META_BASE_URL, META_DEFAULT_MODELS, META_API_KEY_LIFETIME_MS };

// Meta's minted Model API key is valid about 24h. The refresh path re-mints
// from the stored identity token, so the skew just needs to stay comfortably
// below the hard 24h lifetime to avoid last-second races.
export const META_REFRESH_SKEW_MS = 5 * 60 * 1000;
