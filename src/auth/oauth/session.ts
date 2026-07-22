import type { BaseTokens } from "./store.js";

export function isTokenExpired(tokens: BaseTokens, now: number, skewMs: number): boolean {
  return now >= tokens.expiresAt - skewMs;
}

export type TokenSessionDeps<TTokens extends BaseTokens, TAccess> = {
  skewMs: number;
  loadProfile: (name: string, home?: string) => Promise<{ tokens: TTokens } | undefined>;
  updateTokens: (name: string, tokens: TTokens, home?: string) => Promise<void>;
  refreshTokens: (refreshToken: string, now: number) => Promise<TTokens>;
  // Project stored tokens into the access shape returned to callers.
  toAccess: (tokens: TTokens) => TAccess;
  // Optional merge when a refresh response omits provider-specific fields
  // (e.g. Codex accountId rarely re-issued on refresh).
  mergeRefreshed?: (refreshed: TTokens, previous: TTokens) => TTokens;
  missingError: (name: string) => Error;
  refreshFailedError: (name: string, cause: unknown) => Error;
};

export type TokenSession<TTokens extends BaseTokens, TAccess> = {
  isExpired: (tokens: TTokens, now: number) => boolean;
  getValidToken: (name: string, now?: number, home?: string) => Promise<TAccess>;
};

// Resolve a valid access token for a named profile, refreshing transparently
// when the stored token is at or near expiry. Multiple concurrent calls for
// the same profile coalesce into a single refresh; the second returns the
// result of the first.
export function createTokenSession<TTokens extends BaseTokens, TAccess>(
  deps: TokenSessionDeps<TTokens, TAccess>,
): TokenSession<TTokens, TAccess> {
  // Per-profile mutex for token refreshes. When two callers both find the stored
  // token expired and both attempt to refresh, the second observes the same
  // in-flight promise instead of racing against the auth server's rotation
  // policy (which would invalidate one of the refresh attempts).
  const inflightRefresh = new Map<string, Promise<TAccess>>();

  const isExpired = (tokens: TTokens, now: number): boolean =>
    isTokenExpired(tokens, now, deps.skewMs);

  async function doRefresh(name: string, now: number, home?: string): Promise<TAccess> {
    const profile = await deps.loadProfile(name, home);
    if (profile === undefined) throw deps.missingError(name);
    // Re-check expiry after the I/O; another caller may have refreshed already.
    if (!isExpired(profile.tokens, now)) return deps.toAccess(profile.tokens);
    let refreshed: TTokens;
    try {
      refreshed = await deps.refreshTokens(profile.tokens.refresh, now);
    } catch (err) {
      throw deps.refreshFailedError(name, err);
    }
    const merged =
      deps.mergeRefreshed !== undefined ? deps.mergeRefreshed(refreshed, profile.tokens) : refreshed;
    await deps.updateTokens(name, merged, home);
    return deps.toAccess(merged);
  }

  async function getValidToken(
    name: string,
    now: number = Date.now(),
    home?: string,
  ): Promise<TAccess> {
    // Fast path: check expiry without a refresh when we already hold a fresh token.
    const existingProfile = await deps.loadProfile(name, home);
    if (existingProfile === undefined) throw deps.missingError(name);
    if (!isExpired(existingProfile.tokens, now)) return deps.toAccess(existingProfile.tokens);

    // Slow path: a refresh is needed. Deduplicate via the in-flight map so that
    // concurrent callers share the same refresh rather than racing.
    const pending = inflightRefresh.get(name);
    if (pending !== undefined) return pending;

    const refreshPromise = doRefresh(name, now, home);
    inflightRefresh.set(name, refreshPromise);
    // Clean up the mutex entry regardless of outcome so a subsequent call
    // after a failure can retry rather than returning the cached error.
    // Using .then(cleanup, cleanup) instead of .finally() avoids an
    // abandoned promise chain whose pass-through rejection could become
    // an unhandled rejection — callers catch the original refreshPromise.
    const cleanup = (): void => {
      if (inflightRefresh.get(name) === refreshPromise) {
        inflightRefresh.delete(name);
      }
    };
    refreshPromise.then(cleanup, cleanup);

    return refreshPromise;
  }

  return { isExpired, getValidToken };
}
