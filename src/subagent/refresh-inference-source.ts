import type {
  InferenceSource,
  ReactorAction,
  ReactorDirector,
} from "@intx/types/runtime";

import { isCodexTokenExpired } from "../auth/codex/session.js";
import { isXaiTokenExpired } from "../auth/xai/session.js";
import type { OAuthCredentialProvenance } from "../auth/refresh-source-credential.js";
import { refreshSourceCredentialFromRecord } from "../auth/refresh-source-credential.js";
import { loadCodexProfile, loadXaiProfile } from "../config/oauth-stores.js";
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

// Concurrent continuation ensures share one in-flight refresh per credential
// so a burst of post-tool infer decisions issues a single token grant.
const inFlightRefreshes = new Map<string, Promise<InferenceSource>>();

// Directors already wrapped by withContinuationOAuthRefresh, mapped back to
// their proxy. The run.ts factory applies the wrapper once, but the cache
// keeps a second application a no-op instead of stacking duplicate refreshes.
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
    const tokens = (await loadXaiProfile(provenance.profile))?.tokens;
    if (tokens === undefined || isXaiTokenExpired(tokens, Date.now()))
      return false;
    return tokens.access === secret;
  } catch {
    // An unreadable credential store says nothing about expiry. Fall through
    // to the unconditional refresh path, which surfaces the real auth error.
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
 * Ensures the inference source's OAuth credential is valid before a
 * continuation infer runs. Fresh staged tokens return the source untouched —
 * no token-session call, no lock, no latency. Expiring, missing, or
 * unreadable staged tokens fall through to the unconditional refresh path.
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

/**
 * Refreshes every inference source in the bundle whose OAuth credential is
 * expiring. Sources with fresh staged tokens (or no OAuth provenance) pass
 * through untouched.
 */
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
 * Host-layer wrapper: after the inner director returns an infer action, the
 * OAuth credential backing the continuation is ensured fresh and pushed to
 * the live agent before the reactor executes the infer. Non-infer decisions
 * pass through untouched, directors stay pure, and the inner policy stamping
 * runs exactly once.
 *
 * Implemented as a Proxy so the factory keeps returning the director it
 * built: instanceof checks, observe* hooks, and every other member forward
 * to the inner director; only decide() is intercepted.
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
