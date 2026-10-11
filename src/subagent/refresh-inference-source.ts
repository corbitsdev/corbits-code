import type {
  InferenceSource,
  ReactorAction,
  ReactorDirector,
} from "@intx/types/runtime";

import { isCodexTokenExpired } from "../auth/codex/session.js";
import { isMetaTokenExpired } from "../auth/meta/session.js";
import { isXaiTokenExpired } from "../auth/xai/session.js";
import type { OAuthCredentialProvenance } from "../auth/refresh-source-credential.js";
import { refreshSourceCredentialFromRecord } from "../auth/refresh-source-credential.js";
import {
  loadCodexProfile,
  loadMetaProfile,
  loadXaiProfile,
} from "../config/oauth-stores.js";
import {
  findSourceCredentialRecord,
  type SourceCredentialRecord,
} from "../config/source-credentials.js";
import type { ProviderCatalogEntry } from "../config/index.js";

interface ContinuationRefreshAgent {
  setSources(sources: InferenceSource[], defaultSource: string): void;
}

export interface ContinuationRefreshOptions {
  getAgent: () => ContinuationRefreshAgent | null;
  sources: readonly InferenceSource[];
  defaultSource: string;
  catalog: readonly ProviderCatalogEntry[] | undefined;
}

// Share one in-flight refresh per credential so a burst of infer
// decisions issues one grant.
const inFlightRefreshes = new Map<string, Promise<InferenceSource>>();

// Wrapped directors, mapped back to their proxy, so a second application is a
// no-op instead of stacking duplicate refreshes.
const wrappedDirectors = new WeakMap<object, ReactorDirector>();

async function stagedOAuthTokensFresh(
  provenance: OAuthCredentialProvenance,
  secret: string,
): Promise<boolean> {
  try {
    if (provenance.provider === "codex") {
      const tokens = (await loadCodexProfile(provenance.profile))?.tokens;
      if (tokens === undefined || isCodexTokenExpired(tokens, Date.now()))
        return false;
      return tokens.access === secret;
    }
    if (provenance.provider === "meta") {
      const tokens = (await loadMetaProfile(provenance.profile))?.tokens;
      if (tokens === undefined || isMetaTokenExpired(tokens, Date.now()))
        return false;
      return tokens.access === secret;
    }
    const tokens = (await loadXaiProfile(provenance.profile))?.tokens;
    if (tokens === undefined || isXaiTokenExpired(tokens, Date.now()))
      return false;
    return tokens.access === secret;
  } catch {
    // An unreadable store says nothing about expiry; fall through to the
    // refresh path, which surfaces the real auth error.
    return false;
  }
}

async function ensureFreshOAuthSource(
  source: InferenceSource,
  record: SourceCredentialRecord,
): Promise<InferenceSource> {
  const provenance = record.provenance;
  if (provenance.kind !== "oauth") return source;
  if (await stagedOAuthTokensFresh(provenance, record.material.secret))
    return source;
  await refreshSourceCredentialFromRecord(source.credentialId, record);
  return source;
}

/**
 * Ensure the source's OAuth credential is valid before a continuation infer.
 * Fresh staged tokens return the source untouched; expired, missing, or
 * unreadable tokens fall through to the unconditional refresh path.
 */
export async function ensureFreshInferenceSource(
  source: InferenceSource,
  _catalog: readonly ProviderCatalogEntry[] | undefined,
): Promise<InferenceSource> {
  const record = findSourceCredentialRecord(source.credentialId);
  const provenance = record?.provenance;
  if (record === undefined || provenance?.kind !== "oauth") return source;
  const inFlight = inFlightRefreshes.get(source.credentialId);
  if (inFlight !== undefined) return inFlight;
  const pending = ensureFreshOAuthSource(source, record);
  inFlightRefreshes.set(source.credentialId, pending);
  try {
    return await pending;
  } finally {
    if (inFlightRefreshes.get(source.credentialId) === pending)
      inFlightRefreshes.delete(source.credentialId);
  }
}

/** Refresh every bundle source whose OAuth credential is expiring; fresh
 * or non-OAuth sources pass through. */
export async function refreshInferenceSourceBundle(
  sources: readonly InferenceSource[],
  defaultSource: string,
  catalog: readonly ProviderCatalogEntry[] | undefined,
): Promise<{ sources: InferenceSource[]; defaultSource: string }> {
  const refreshed = await Promise.all(
    sources.map((source) => ensureFreshInferenceSource(source, catalog)),
  );
  return { sources: refreshed, defaultSource };
}

function returnsInferAction(
  result: ReactorAction | readonly ReactorAction[],
): boolean {
  const list = Array.isArray(result) ? result : [result];
  return list.some((action) => action?.type === "infer");
}

/**
 * Host-layer wrapper: when the inner director returns an infer action, ensure
 * the continuation's OAuth credential is fresh and push it to the live agent
 * before the reactor executes. Non-infer decisions pass through untouched.
 *
 * Implemented as a Proxy so the factory keeps returning the director it
 * built; only decide() is intercepted.
 */
export function withContinuationOAuthRefresh<TDirector extends ReactorDirector>(
  inner: TDirector,
  options: ContinuationRefreshOptions,
): TDirector {
  const cached = wrappedDirectors.get(inner);
  if (cached !== undefined) return cached as TDirector;
  const decide = async (
    event: Parameters<TDirector["decide"]>[0],
    state: Parameters<TDirector["decide"]>[1],
    capabilities: Parameters<TDirector["decide"]>[2],
  ) => {
    const result = await inner.decide(event, state, capabilities);
    if (!returnsInferAction(result)) return result;
    const agent = options.getAgent();
    if (agent === null) return result;
    const fresh = await refreshInferenceSourceBundle(
      options.sources,
      options.defaultSource,
      options.catalog,
    );
    agent.setSources(fresh.sources, fresh.defaultSource);
    return result;
  };
  const proxy = new Proxy(inner, {
    get(target, property, _receiver) {
      if (property === "decide") return decide;
      return Reflect.get(target, property);
    },
  });
  wrappedDirectors.set(inner, proxy);
  wrappedDirectors.set(proxy, proxy);
  return proxy;
}
