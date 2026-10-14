import {
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
  createProviderTokenSession,
  type TokenSessionCallContext,
} from "../provider-token-session.js";

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

export const xaiTokensSession = createProviderTokenSession<
  XaiTokens,
  XaiAccess
>({
  errorClass: XaiAuthError,
  providerLabel: "xAI",
  skewMs: XAI_REFRESH_SKEW_MS,
  loadProfile: loadXaiProfile,
  updateTokens: updateXaiTokens,
  toAccess: (tokens) => ({ access: tokens.access }),
  refreshTokens: (refreshToken, now) => refreshXaiTokens(refreshToken, now),
  // No inter-process lock here: xAI never rotates refresh tokens, so
  // overlapping grants cannot revoke each other. What IS needed is the
  // committed-winner recovery: a lost invalid_grant race must return the
  // rotation another session committed instead of a re-login error.
  serializeRefresh: (ctx) => recoverCommittedXaiWinner(ctx),
});

// On a shared credential two independent sessions may refresh at once; the
// loser's grant is rejected with invalid_grant. If a newer committed winner
// exists on disk by the time we fail, that is the shared credential's fresh
// access token — return it instead of a re-login error.
async function recoverCommittedXaiWinner({
  home,
  name,
  now,
  getValid,
  session,
}: TokenSessionCallContext<XaiTokens, XaiAccess>): Promise<XaiAccess> {
  const basis = await loadXaiProfile(name, home);
  try {
    return await getValid();
  } catch (error) {
    if (error instanceof OAuthRefreshFailedError && basis !== undefined) {
      const winner = await loadXaiProfile(name, home);
      if (
        winner !== undefined &&
        !session.isExpired(winner.tokens, now) &&
        // A committed rotation always changes the access token or its
        // lifetime; an unchanged profile is not a winner to recover.
        (winner.tokens.access !== basis.tokens.access ||
          winner.tokens.expiresAt !== basis.tokens.expiresAt)
      )
        return { access: winner.tokens.access };
    }
    throw error;
  }
}

export function createXaiTokenSession(
  home?: string,
): TokenSession<XaiTokens, XaiAccess> {
  return xaiTokensSession.createSession(home);
}

export function isXaiTokenExpired(tokens: XaiTokens, now: number): boolean {
  return xaiTokensSession.isExpired(tokens, now);
}

export async function getValidXaiToken(
  name: string,
  now?: number,
  home?: string,
): Promise<XaiAccess> {
  return xaiTokensSession.getValidToken(name, now, home);
}

export async function refreshStagedXaiTokens(
  tokens: XaiTokens,
  now: number = Date.now(),
): Promise<XaiTokens> {
  return xaiTokensSession.refreshStaged(tokens, now);
}
