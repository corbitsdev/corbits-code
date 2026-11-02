import { CODEX_BASE_URL } from "../auth/codex/constants.js";
import type { CodexProfile } from "../auth/codex/store.js";
import { selectableCodexModelIds } from "../provider/codex-model-catalog.js";
import { createOAuthProviderProjection } from "./oauth-providers.js";

export const CODEX_PROVIDER_PREFIX = "codex/";

// Codex catalog entries carry the `codexProfile` marker and `codexAccountId`
// so the runtime routes them to the Responses adapter and supplies the
// chatgpt-account-id header.
const projection = createOAuthProviderProjection<CodexProfile>({
  prefix: CODEX_PROVIDER_PREFIX,
  baseURL: CODEX_BASE_URL,
  models: selectableCodexModelIds,
  catalogExtras: (profile) => ({
    codexProfile: profile.name,
    ...(profile.tokens.accountId !== undefined
      ? { codexAccountId: profile.tokens.accountId }
      : {}),
  }),
});

export const codexProviderName = projection.providerName;
export const isCodexProviderName = projection.isProviderName;
export const codexProfileFromProviderName = projection.profileFromProviderName;
export const codexProvidersAsSettings = projection.providersAsSettings;
export const codexProfilesToCatalogEntries =
  projection.profilesToCatalogEntries;
