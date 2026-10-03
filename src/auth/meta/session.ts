import {
  createTokenSession,
  isTokenExpired,
  OAuthProfileNotFoundError,
  OAuthRefreshFailedError,
  type TokenSession,
} from "@corbits/oauth-core";
import {
  refreshMetaTokens,
  type MetaOAuthTokens,
} from "@corbits/meta-provider";

import {
  loadMetaProfile,
  updateMetaTokens,
} from "../../config/oauth-stores.js";
import {
  replaceMutableTokens,
  sanitizedRefreshFailure,
} from "../token-session-boundary.js";
import { META_REFRESH_SKEW_MS } from "./constants.js";

// Raised when a Meta profile cannot yield a usable access token: it is gone,
// or its identity token has been revoked/expired (401/403 on re-mint). Carries
// the profile name so the TUI can name the affected profile in a re-login
// prompt.
export class MetaAuthError extends Error {
  readonly profile: string;
  readonly reason: "missing" | "refresh-failed";

  constructor(
    profile: string,
    reason: "missing" | "refresh-failed",
    message: string,
  ) {
    super(message);
    this.name = "MetaAuthError";
    this.profile = profile;
    this.reason = reason;
  }
}

export interface MetaAccess {
  access: string;
}

function wrapMetaAuthError(name: string, err: unknown): never {
  if (err instanceof OAuthProfileNotFoundError) {
    throw new MetaAuthError(
      name,
      "missing",
      `Meta profile "${name}" is not authorized. Log in again.`,
    );
  }
  if (err instanceof OAuthRefreshFailedError) {
    const cause = err.cause;
    throw new MetaAuthError(
      name,
      "refresh-failed",
      `Meta profile "${name}" could not be refreshed (${cause instanceof Error ? cause.message : String(cause)}). Log in again.`,
    );
  }
  throw err;
}

const sessions = new Map<string, TokenSession<MetaOAuthTokens, MetaAccess>>();

export function createMetaTokenSession(
  home?: string,
): TokenSession<MetaOAuthTokens, MetaAccess> {
  const refreshBasis = new WeakMap<MetaOAuthTokens, string>();
  const inner = createTokenSession<MetaOAuthTokens, MetaAccess>({
    skewMs: META_REFRESH_SKEW_MS,
    loadProfile: (name) => loadMetaProfile(name, home),
    updateTokens: async (name, tokens) => {
      const winner = await updateMetaTokens(
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
        const refreshed = await refreshMetaTokens(refreshToken, now);
        refreshBasis.set(refreshed, refreshToken);
        return refreshed;
      } catch (error) {
        throw sanitizedRefreshFailure(error, refreshToken);
      }
    },
    toAccess: (tokens) => ({ access: tokens.access }),
  });
  return {
    isExpired: inner.isExpired,
    getValidToken: async (name, now = Date.now()) => {
      const basis = await loadMetaProfile(name, home);
      try {
        return await inner.getValidToken(name, now);
      } catch (error) {
        if (error instanceof OAuthRefreshFailedError && basis !== undefined) {
          const winner = await loadMetaProfile(name, home);
          if (
            winner !== undefined &&
            !inner.isExpired(winner.tokens, now) &&
            (winner.tokens.access !== basis.tokens.access ||
              winner.tokens.expiresAt !== basis.tokens.expiresAt)
          )
            return { access: winner.tokens.access };
        }
        throw error;
      }
    },
  };
}

function sessionFor(home?: string): TokenSession<MetaOAuthTokens, MetaAccess> {
  const key = home ?? "";
  const existing = sessions.get(key);
  if (existing !== undefined) return existing;
  const created = createMetaTokenSession(home);
  sessions.set(key, created);
  return created;
}

export function isMetaTokenExpired(
  tokens: MetaOAuthTokens,
  now: number,
): boolean {
  return isTokenExpired(tokens, now, META_REFRESH_SKEW_MS);
}

export async function getValidMetaToken(
  name: string,
  now?: number,
  home?: string,
): Promise<MetaAccess> {
  try {
    return await sessionFor(home).getValidToken(name, now);
  } catch (err) {
    wrapMetaAuthError(name, err);
  }
}

export async function refreshStagedMetaTokens(
  tokens: MetaOAuthTokens,
  now: number = Date.now(),
): Promise<MetaOAuthTokens> {
  if (!isMetaTokenExpired(tokens, now)) return tokens;
  let refreshed: MetaOAuthTokens;
  try {
    refreshed = await refreshMetaTokens(tokens.refresh, now);
  } catch (error) {
    throw sanitizedRefreshFailure(error, tokens.refresh);
  }
  replaceMutableTokens(tokens, refreshed);
  return tokens;
}
