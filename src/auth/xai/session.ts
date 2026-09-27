import {
  createTokenSession,
  isTokenExpired,
  OAuthProfileNotFoundError,
  OAuthRefreshFailedError,
  type TokenSession,
} from "@corbits/oauth-core";
import {
  refreshXaiTokens,
  XAI_REFRESH_SKEW_MS,
  type XaiTokens,
} from "@corbits/xai-provider";

import { loadXaiProfile, updateXaiTokens } from "../../config/oauth-stores.js";
import {
  replaceMutableTokens,
  sanitizedRefreshFailure,
} from "../token-session-boundary.js";

export class XaiAuthError extends Error {
  readonly profile: string;
  readonly reason: "missing" | "refresh-failed";

  constructor(
    profile: string,
    reason: "missing" | "refresh-failed",
    message: string,
  ) {
    super(message);
    this.name = "XaiAuthError";
    this.profile = profile;
    this.reason = reason;
  }
}

export interface XaiAccess {
  access: string;
}

function wrapXaiAuthError(name: string, err: unknown): never {
  if (err instanceof OAuthProfileNotFoundError) {
    throw new XaiAuthError(
      name,
      "missing",
      `xAI profile "${name}" is not authorized. Log in again.`,
    );
  }
  if (err instanceof OAuthRefreshFailedError) {
    const cause = err.cause;
    throw new XaiAuthError(
      name,
      "refresh-failed",
      `xAI profile "${name}" could not be refreshed (${cause instanceof Error ? cause.message : String(cause)}). Log in again.`,
    );
  }
  throw err;
}

const sessions = new Map<string, TokenSession<XaiTokens, XaiAccess>>();

export function createXaiTokenSession(
  home?: string,
): TokenSession<XaiTokens, XaiAccess> {
  const refreshBasis = new WeakMap<XaiTokens, string>();
  const inner = createTokenSession<XaiTokens, XaiAccess>({
    skewMs: XAI_REFRESH_SKEW_MS,
    loadProfile: (name) => loadXaiProfile(name, home),
    updateTokens: async (name, tokens) => {
      const winner = await updateXaiTokens(
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
        const refreshed = await refreshXaiTokens(refreshToken, now);
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
      const basis = await loadXaiProfile(name, home);
      try {
        return await inner.getValidToken(name, now);
      } catch (error) {
        if (error instanceof OAuthRefreshFailedError && basis !== undefined) {
          const winner = await loadXaiProfile(name, home);
          if (
            winner !== undefined &&
            winner.tokens.refresh !== basis.tokens.refresh &&
            !inner.isExpired(winner.tokens, now)
          )
            return { access: winner.tokens.access };
        }
        throw error;
      }
    },
  };
}

function sessionFor(home?: string): TokenSession<XaiTokens, XaiAccess> {
  const key = home ?? "";
  const existing = sessions.get(key);
  if (existing !== undefined) return existing;
  const created = createXaiTokenSession(home);
  sessions.set(key, created);
  return created;
}

export function isXaiTokenExpired(tokens: XaiTokens, now: number): boolean {
  return isTokenExpired(tokens, now, XAI_REFRESH_SKEW_MS);
}

export async function getValidXaiToken(
  name: string,
  now?: number,
  home?: string,
): Promise<XaiAccess> {
  try {
    return await sessionFor(home).getValidToken(name, now);
  } catch (err) {
    wrapXaiAuthError(name, err);
  }
}

export async function refreshStagedXaiTokens(
  tokens: XaiTokens,
  now: number = Date.now(),
): Promise<XaiTokens> {
  if (!isXaiTokenExpired(tokens, now)) return tokens;
  let refreshed: XaiTokens;
  try {
    refreshed = await refreshXaiTokens(tokens.refresh, now);
  } catch (error) {
    throw sanitizedRefreshFailure(error, tokens.refresh);
  }
  replaceMutableTokens(tokens, refreshed);
  return tokens;
}
