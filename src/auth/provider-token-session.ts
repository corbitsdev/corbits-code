import {
  createTokenSession,
  isTokenExpired,
  OAuthProfileNotFoundError,
  OAuthRefreshFailedError,
  type AuthProfile,
  type BaseTokens,
  type TokenSession,
} from "@corbits/oauth-core";

import {
  replaceMutableTokens,
  sanitizedRefreshFailure,
} from "./token-session-boundary.js";

export type ProviderAuthErrorReason = "missing" | "refresh-failed";

export type ProviderAuthError = Error & {
  readonly profile: string;
  readonly reason: ProviderAuthErrorReason;
};

export type ProviderAuthErrorClass = new (
  profile: string,
  reason: ProviderAuthErrorReason,
  message: string,
) => ProviderAuthError;

// Where the session posts refreshed tokens back to the store: the winner is
// this update, a concurrent refresh's value, or undefined after removal.
export type ProviderTokenStoreUpdate<TTokens extends BaseTokens> = (
  name: string,
  tokens: TTokens,
  home: string | undefined,
  expectedRefreshToken: string | undefined,
) => Promise<AuthProfile<TTokens> | undefined>;

// Context one getValidToken call hands to the reconcile hook: `session` is
// the unwrapped inner session, and `getValid` the raw store-driven path.
export interface TokenSessionCallContext<TTokens extends BaseTokens, TAccess> {
  home?: string | undefined;
  name: string;
  now: number;
  session: TokenSession<TTokens, TAccess>;
  getValid: () => Promise<TAccess>;
}

export interface ProviderTokenSessionSpec<TTokens extends BaseTokens, TAccess> {
  errorClass: ProviderAuthErrorClass;
  /** Profile label in re-login messaging, e.g. "Codex" or "xAI". */
  providerLabel: string;
  skewMs: number;
  loadProfile: (
    name: string,
    home?: string,
  ) => Promise<AuthProfile<TTokens> | undefined>;
  updateTokens: ProviderTokenStoreUpdate<TTokens>;
  toAccess: (tokens: TTokens) => TAccess;
  // Fresh tokens from a stored refresh token. `previous` rides along for
  // staged refreshes (full prior tokens) and is absent on the session's
  // endpoint-driven refresh.
  refreshTokens: (
    refreshToken: string,
    now: number,
    previous?: TTokens,
  ) => Promise<TTokens>;
  mergeRefreshed?: (refreshed: TTokens, previous: TTokens) => TTokens;
  serializeRefresh?: (
    ctx: TokenSessionCallContext<TTokens, TAccess>,
  ) => Promise<TAccess>;
}

export interface ProviderTokenSessionApi<TTokens extends BaseTokens, TAccess> {
  createSession: (home?: string) => TokenSession<TTokens, TAccess>;
  sessionFor: (home?: string) => TokenSession<TTokens, TAccess>;
  isExpired: (tokens: TTokens, now: number) => boolean;
  getValidToken: (
    name: string,
    now?: number,
    home?: string,
  ) => Promise<TAccess>;
  refreshStaged: (tokens: TTokens, now?: number) => Promise<TTokens>;
}

export function createProviderTokenSession<TTokens extends BaseTokens, TAccess>(
  spec: ProviderTokenSessionSpec<TTokens, TAccess>,
): ProviderTokenSessionApi<TTokens, TAccess> {
  const isExpired = (tokens: TTokens, now: number): boolean =>
    isTokenExpired(tokens, now, spec.skewMs);

  const sessions = new Map<string, TokenSession<TTokens, TAccess>>();

  // Each session carries its own in-flight deduplication, so two sessions
  // over one home behave like two processes sharing one credential store.
  const createSession = (home?: string): TokenSession<TTokens, TAccess> => {
    // Map each refreshed token to the raw refresh token that produced it,
    // so updateTokens can CAS-compare at the store; it survives the merge
    // and the mutable-token swap inside the store update.
    const refreshBasis = new WeakMap<TTokens, string>();

    const inner = createTokenSession<TTokens, TAccess>({
      skewMs: spec.skewMs,
      loadProfile: (name) => spec.loadProfile(name, home),
      updateTokens: async (name, tokens) => {
        const winner = await spec.updateTokens(
          name,
          tokens,
          home,
          refreshBasis.get(tokens),
        );
        if (winner === undefined) throw new OAuthProfileNotFoundError(name);
        replaceMutableTokens(tokens, winner.tokens);
      },
      refreshTokens: async (refreshToken, now) => {
        try {
          const refreshed = await spec.refreshTokens(refreshToken, now);
          refreshBasis.set(refreshed, refreshToken);
          return refreshed;
        } catch (error) {
          throw sanitizedRefreshFailure(error, refreshToken);
        }
      },
      toAccess: spec.toAccess,
      mergeRefreshed: (refreshed, previous) => {
        const merged = spec.mergeRefreshed
          ? spec.mergeRefreshed(refreshed, previous)
          : refreshed;
        const basis = refreshBasis.get(refreshed);
        if (basis !== undefined) refreshBasis.set(merged, basis);
        return merged;
      },
    });

    if (spec.serializeRefresh === undefined) return inner;
    const serialize = spec.serializeRefresh;
    const nowOrDefault = (now: number | undefined): number =>
      now === undefined ? Date.now() : now;
    return {
      isExpired: inner.isExpired,
      getValidToken: (name, now) => {
        const at = nowOrDefault(now);
        return serialize({
          home,
          name,
          now: at,
          session: inner,
          getValid: () => inner.getValidToken(name, at),
        });
      },
    };
  };

  const sessionFor = (home?: string): TokenSession<TTokens, TAccess> => {
    const key = home ?? "";
    const existing = sessions.get(key);
    if (existing !== undefined) return existing;
    const created = createSession(home);
    sessions.set(key, created);
    return created;
  };

  // Projects the core's own errors onto the provider error: anything else is
  // not ours to reclassify (e.g. a refresh lock timeout carries its own
  // recovery path and must never compose into credential_failure).
  const wrapAuthFailure = (name: string, err: unknown): unknown => {
    if (err instanceof OAuthProfileNotFoundError) {
      return new spec.errorClass(
        name,
        "missing",
        `${spec.providerLabel} profile "${name}" is not authorized. Log in again.`,
      );
    }
    if (err instanceof OAuthRefreshFailedError) {
      const cause = err.cause;
      return new spec.errorClass(
        name,
        "refresh-failed",
        `${spec.providerLabel} profile "${name}" could not be refreshed ` +
          `(${cause instanceof Error ? cause.message : String(cause)}). Log in again.`,
      );
    }
    return err;
  };

  return {
    createSession,
    sessionFor,
    isExpired,
    getValidToken: async (name, now, home) => {
      try {
        return await sessionFor(home).getValidToken(name, now);
      } catch (err) {
        throw wrapAuthFailure(name, err);
      }
    },
    refreshStaged: async (tokens, now = Date.now()) => {
      if (!isExpired(tokens, now)) return tokens;
      let refreshed: TTokens;
      try {
        refreshed = await spec.refreshTokens(tokens.refresh, now, tokens);
      } catch (error) {
        throw sanitizedRefreshFailure(error, tokens.refresh);
      }
      replaceMutableTokens(tokens, refreshed);
      return tokens;
    },
  };
}
