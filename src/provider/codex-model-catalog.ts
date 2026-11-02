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
  logCatalogFallback,
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

// The last live list per login, so a list is only ever read back for the login
// that served it and a reconnected profile never shows the previous account's
// list. A login with no account id is told apart by its creation time: a token
// refresh keeps that, and a new sign-in changes it.
const liveLists = new Map<string, readonly [string, ...string[]]>();

function listKey(
  profile: Pick<CodexProfile, "name" | "createdAt">,
  accountId: string | undefined,
) {
  return JSON.stringify([profile.name, accountId ?? profile.createdAt]);
}

/** Sync picker ids for a ChatGPT profile: its login's last live list, else the built-in list. Never empty. */
export function selectableCodexModelIds(
  profile: CodexProfile,
): readonly [string, ...string[]] {
  return (
    liveLists.get(listKey(profile, profile.tokens.accountId)) ??
    CODEX_DEFAULT_MODELS
  );
}

async function prefetchProfileModels(profile: CodexProfile): Promise<void> {
  const catalogLabel = `ChatGPT profile ${profile.name}`;
  // A token refresh can name an account the stored profile does not have yet,
  // so the token that made the request picks where its list is kept. A token
  // read that fails gets one more try before the fetch counts as failed.
  let accountId = profile.tokens.accountId;
  const state = await createCodexModelCatalog(catalogLabel, async () => {
    const access = await getValidCodexToken(profile.name).catch(() =>
      getValidCodexToken(profile.name),
    );
    accountId = access.accountId;
    return access;
  }).discoverModels();
  const key = listKey(profile, accountId);
  if (state.status === "models") {
    liveLists.set(key, state.models);
    return;
  }
  // Empty and failed fetches leave a live list in place: stale-but-live beats
  // the built-in list.
  logCatalogFallback(
    catalogLabel,
    state,
    liveLists.has(key) ? "the last live list" : "the built-in list",
  );
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

/**
 * Keep the list a sign-in showed once its profile is saved, so the fetch after
 * connecting failing leaves the models the operator just saw, not the built-in
 * list.
 */
export function rememberConnectedCodexModels(
  profile: CodexProfile,
  models: readonly string[],
): void {
  const [first, ...rest] = models;
  if (first === undefined) return;
  liveLists.set(listKey(profile, profile.tokens.accountId), [first, ...rest]);
}

export function resetCodexModelDiscoveryForTests(): void {
  liveLists.clear();
}
