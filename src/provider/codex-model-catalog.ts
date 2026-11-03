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

// The last live list per sign-in, so a list is only ever read back for the
// sign-in that served it and a reconnected profile never shows the previous
// login's list. A sign-in is its profile name and creation time: a token
// refresh keeps the creation time, even when it teaches the profile its
// account id, and a new sign-in changes it. The account id is not part of the
// key because the token that served a fetch and the stored profile can name it
// differently, or not at all.
interface LiveList {
  readonly models: readonly [string, ...string[]];
  /** When the request that produced it started; a later one replaces it. */
  readonly ticket: number;
}

const liveLists = new Map<string, LiveList>();
let lastTicket = 0;

function listKey(profile: Pick<CodexProfile, "name" | "createdAt">) {
  return JSON.stringify([profile.name, profile.createdAt]);
}

/** Replaces the key's list unless a later request's answer is already there. */
function storeLiveList(
  key: string,
  models: readonly [string, ...string[]],
  ticket: number,
): void {
  const current = liveLists.get(key);
  if (current === undefined || current.ticket < ticket) {
    liveLists.set(key, { models, ticket });
  }
}

/** Sync picker ids for a ChatGPT profile: its sign-in's last live list, else the built-in list. Never empty. */
export function selectableCodexModelIds(
  profile: CodexProfile,
): readonly [string, ...string[]] {
  return liveLists.get(listKey(profile))?.models ?? CODEX_DEFAULT_MODELS;
}

async function prefetchProfileModels(profile: CodexProfile): Promise<void> {
  const catalogLabel = `ChatGPT profile ${profile.name}`;
  // Requests are ordered by when they start: overlapping fetches for one
  // sign-in can answer in any order, and the older answer must not win. A
  // token read that fails gets one more try before the fetch counts as failed.
  lastTicket += 1;
  const ticket = lastTicket;
  const state = await createCodexModelCatalog(catalogLabel, () =>
    getValidCodexToken(profile.name).catch(() =>
      getValidCodexToken(profile.name),
    ),
  ).discoverModels();
  const key = listKey(profile);
  if (state.status === "models") {
    storeLiveList(key, state.models, ticket);
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
  // Newer than every fetch started so far: one still in flight answers with
  // an older view and must not replace the list the operator just chose from.
  lastTicket += 1;
  storeLiveList(listKey(profile), [first, ...rest], lastTicket);
}

export function resetCodexModelDiscoveryForTests(): void {
  liveLists.clear();
}
