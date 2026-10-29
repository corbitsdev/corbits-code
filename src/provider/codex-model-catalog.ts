import { type } from "arktype";

import { codexAuthHeadersForToken } from "../auth/codex/auth-headers.js";
import {
  CODEX_DEFAULT_MODELS,
  CODEX_MODELS_URL,
} from "../auth/codex/constants.js";
import {
  type CodexAccess,
  getValidCodexToken,
  refreshStagedCodexTokens,
} from "../auth/codex/session.js";
import type { CodexProfile, CodexTokens } from "../auth/codex/store.js";
import { COMMAND_NAME } from "../branding.js";
import { listCodexProfiles } from "../config/oauth-stores.js";
import {
  type CatalogDiscoveryState,
  createBoundedModelCatalog,
} from "./bounded-model-catalog.js";
import { DEFAULT_MODELS_REQUEST_TIMEOUT_MS } from "./models-endpoint.js";

// Each entry carries its base instructions, so the catalog runs to hundreds
// of KB and grows with every model.
const MAX_CODEX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_CODEX_CATALOG_MODELS = 1024;

const CodexModelsResponse = type({ models: "unknown[]" });

// Validated per entry so one model with a new visibility value or a missing
// field drops only that model, not the account's whole catalog.
const CodexModelEntry = type({
  slug: "string",
  visibility: "string",
  priority: "number",
});

function parseCodexModels(
  raw: unknown,
  cap: { readonly maxModels: number; readonly oversizeMessage: string },
): CatalogDiscoveryState {
  const parsed = CodexModelsResponse(raw);
  if (parsed instanceof type.errors) {
    return { status: "malformed", message: parsed.summary };
  }
  if (parsed.models.length > cap.maxModels) {
    return { status: "malformed", message: cap.oversizeMessage };
  }
  const entries = parsed.models.map((model) => CodexModelEntry(model));
  const valid = entries.filter(
    (entry): entry is typeof CodexModelEntry.infer =>
      !(entry instanceof type.errors),
  );
  // Every entry failing the per-entry contract means the contract moved;
  // reporting that as an empty catalog would point at client_version instead.
  const firstError = entries.find((entry) => entry instanceof type.errors);
  if (valid.length === 0 && firstError instanceof type.errors) {
    return { status: "malformed", message: firstError.summary };
  }
  const listed = valid
    .filter((entry) => entry.visibility === "list")
    .sort((a, b) => a.priority - b.priority);
  const [first, ...rest] = new Set(
    listed.map(({ slug }) => slug.trim()).filter((slug) => slug.length > 0),
  );
  return first === undefined
    ? { status: "empty" }
    : { status: "models", models: [first, ...rest] };
}

function createCodexModelCatalog(
  catalogLabel: string,
  token: () => Promise<CodexAccess>,
) {
  return createBoundedModelCatalog({
    seedIds: CODEX_DEFAULT_MODELS,
    catalogLabel,
    maxBytes: MAX_CODEX_CATALOG_BYTES,
    maxModels: MAX_CODEX_CATALOG_MODELS,
    request: async ({ timeoutMs, signal }) => {
      const access = await token();
      const timeout = AbortSignal.timeout(
        timeoutMs ?? DEFAULT_MODELS_REQUEST_TIMEOUT_MS,
      );
      return fetch(CODEX_MODELS_URL, {
        method: "GET",
        headers: codexAuthHeadersForToken(access, COMMAND_NAME),
        signal:
          signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
    },
    parse: parseCodexModels,
  });
}

// One catalog per profile and account, so a list is only ever read back for
// the account that served it and a reconnected profile never shows the
// previous account's list.
const catalogs = new Map<string, ReturnType<typeof createCodexModelCatalog>>();

function catalogKey(profileName: string, accountId: string | undefined) {
  return JSON.stringify([profileName, accountId ?? null]);
}

/** Sync picker ids for a ChatGPT profile: its account's last live list, else the built-in list. Never empty. */
export function selectableCodexModelIds(
  profile: CodexProfile,
): readonly [string, ...string[]] {
  return (
    catalogs
      .get(catalogKey(profile.name, profile.tokens.accountId))
      ?.selectableModelIds() ?? CODEX_DEFAULT_MODELS
  );
}

async function prefetchProfileModels(profile: CodexProfile): Promise<void> {
  // A token refresh can name an account the stored profile does not have
  // yet, so the refreshed token picks the catalog. When the refresh fails,
  // the catalog's own request fails the same way and logs why.
  const accountId = await getValidCodexToken(profile.name).then(
    (access) => access.accountId,
    () => profile.tokens.accountId,
  );
  const key = catalogKey(profile.name, accountId);
  const catalog =
    catalogs.get(key) ??
    createCodexModelCatalog(`ChatGPT profile ${profile.name}`, () =>
      getValidCodexToken(profile.name),
    );
  catalogs.set(key, catalog);
  await catalog.prefetchModels();
}

/** Fetch every stored ChatGPT profile's live catalog; failures keep the fallback and log why. */
export async function prefetchCodexModels(): Promise<void> {
  const profiles = await listCodexProfiles();
  await Promise.all(profiles.map(prefetchProfileModels));
}

/** One fetch for a sign-in not yet saved as a profile. Never rejects; a failure is a non-`models` state. */
export function discoverStagedCodexModels(
  tokens: CodexTokens,
): Promise<CatalogDiscoveryState> {
  return createCodexModelCatalog("ChatGPT sign-in", () =>
    refreshStagedCodexTokens(tokens),
  ).discoverModels();
}

export function resetCodexModelDiscoveryForTests(): void {
  catalogs.clear();
}
