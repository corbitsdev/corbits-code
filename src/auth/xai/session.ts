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

function sessionFor(home?: string): TokenSession<XaiTokens, XaiAccess> {
  const key = home ?? "";
  const existing = sessions.get(key);
  if (existing !== undefined) return existing;
  const created = createTokenSession<XaiTokens, XaiAccess>({
    skewMs: XAI_REFRESH_SKEW_MS,
    loadProfile: (name) => loadXaiProfile(name, home),
    updateTokens: (name, tokens) => updateXaiTokens(name, tokens, home),
    refreshTokens: refreshXaiTokens,
    toAccess: (tokens) => ({ access: tokens.access }),
  });
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
  const refreshed = await refreshXaiTokens(tokens.refresh, now);
  Object.assign(tokens, refreshed);
  return tokens;
}
