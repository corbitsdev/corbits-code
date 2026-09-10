import {
  createTokenSession,
  isTokenExpired,
  OAuthProfileNotFoundError,
  OAuthRefreshFailedError,
  type TokenSession,
} from "@corbits/oauth-core";
import {
  CODEX_REFRESH_SKEW_MS,
  refreshCodexTokens,
  type CodexTokens,
} from "@corbits/codex-provider";

import {
  loadCodexProfile,
  updateCodexTokens,
} from "../../config/oauth-stores.js";
import { withDefaultCodexExpiry } from "./store.js";

// Raised when a Codex profile cannot yield a usable access token: it is gone,
// or its refresh token has been revoked/expired. Carries the profile name so
// the TUI can name the affected profile in a re-login prompt. `reason`
// distinguishes "never authorized" from "refresh rejected" for messaging.
export class CodexAuthError extends Error {
  readonly profile: string;
  readonly reason: "missing" | "refresh-failed";

  constructor(
    profile: string,
    reason: "missing" | "refresh-failed",
    message: string,
  ) {
    super(message);
    this.name = "CodexAuthError";
    this.profile = profile;
    this.reason = reason;
  }
}

// A usable access token plus the account id that must ride alongside it in the
// chatgpt-account-id header. Returned together so callers need a single load,
// not a token fetch followed by a separate profile read (which could observe a
// token and account id from two different points in a concurrent refresh).
export interface CodexAccess {
  access: string;
  accountId?: string | undefined;
}

function wrapCodexAuthError(name: string, err: unknown): never {
  if (err instanceof OAuthProfileNotFoundError) {
    throw new CodexAuthError(
      name,
      "missing",
      `Codex profile "${name}" is not authorized. Log in again.`,
    );
  }
  if (err instanceof OAuthRefreshFailedError) {
    const cause = err.cause;
    throw new CodexAuthError(
      name,
      "refresh-failed",
      `Codex profile "${name}" could not be refreshed (${cause instanceof Error ? cause.message : String(cause)}). Log in again.`,
    );
  }
  throw err;
}

const sessions = new Map<string, TokenSession<CodexTokens, CodexAccess>>();

async function refreshCodexTokensForStore(
  refreshToken: string,
  now: number,
  previous: CodexTokens,
): Promise<CodexTokens> {
  return withDefaultCodexExpiry(
    await refreshCodexTokens(refreshToken, now, previous),
    now,
  );
}

function sessionFor(home?: string): TokenSession<CodexTokens, CodexAccess> {
  const key = home ?? "";
  const existing = sessions.get(key);
  if (existing !== undefined) return existing;
  const created = createTokenSession<CodexTokens, CodexAccess>({
    skewMs: CODEX_REFRESH_SKEW_MS,
    loadProfile: (name) => loadCodexProfile(name, home),
    updateTokens: (name, tokens) => updateCodexTokens(name, tokens, home),
    // createTokenSession only passes (refresh, now). The package refresh
    // helper needs prior tokens to keep chatgpt-account-id; mergeRefreshed
    // supplies that after this stub call.
    refreshTokens: (refreshToken, now) =>
      refreshCodexTokensForStore(refreshToken, now, {
        access: "",
        refresh: refreshToken,
      }),
    toAccess: (tokens) => ({
      access: tokens.access,
      accountId: tokens.accountId,
    }),
    mergeRefreshed: (refreshed, previous) =>
      refreshed.accountId === undefined && previous.accountId !== undefined
        ? { ...refreshed, accountId: previous.accountId }
        : refreshed,
  });
  sessions.set(key, created);
  return created;
}

export function isCodexTokenExpired(tokens: CodexTokens, now: number): boolean {
  return isTokenExpired(tokens, now, CODEX_REFRESH_SKEW_MS);
}

export async function getValidCodexToken(
  name: string,
  now?: number,
  home?: string,
): Promise<CodexAccess> {
  try {
    return await sessionFor(home).getValidToken(name, now);
  } catch (err) {
    wrapCodexAuthError(name, err);
  }
}

export async function refreshStagedCodexTokens(
  tokens: CodexTokens,
  now: number = Date.now(),
): Promise<CodexTokens> {
  if (!isCodexTokenExpired(tokens, now)) return tokens;
  const refreshed = await refreshCodexTokensForStore(
    tokens.refresh,
    now,
    tokens,
  );
  Object.assign(tokens, refreshed);
  return tokens;
}
