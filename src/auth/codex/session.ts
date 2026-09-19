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
  codexAuthPath,
  loadCodexProfile,
  updateCodexTokens,
} from "../../config/oauth-stores.js";
import type { InferenceErrorLike } from "../../inference-gateway-error.js";
import {
  CodexRefreshLockTimeoutError,
  withCodexRefreshLock,
} from "./refresh-lock.js";
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

// Raised when a Codex refresh cannot even acquire the inter-process refresh
// lock: contention or a crashed holder's leftover file, never a bad
// credential. Deliberately NOT a CodexAuthError — folding it into
// credential_failure tells the operator to log in again, which never removes
// the lock file (a futile loop). Carries the profile and lock path so every
// surface can repeat the manual-removal recovery instead of a re-login hint.
export class CodexRefreshLockError extends Error {
  readonly profile: string;
  readonly lockPath: string;

  constructor(profile: string, lockPath: string, detail: string) {
    super(`Codex profile "${profile}" could not refresh (${detail})`);
    this.name = "CodexRefreshLockError";
    this.profile = profile;
    this.lockPath = lockPath;
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

/**
 * Builds an independent Codex token session for a home directory. Each
 * session carries its own in-flight deduplication, so two sessions over the
 * same home behave like two processes sharing one credential store.
 */
export function createCodexTokenSession(
  home?: string,
): TokenSession<CodexTokens, CodexAccess> {
  const inner = createTokenSession<CodexTokens, CodexAccess>({
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
  return {
    isExpired: inner.isExpired,
    getValidToken: (name, now = Date.now()) =>
      withSerializedCodexRefresh(home, name, now, () =>
        inner.getValidToken(name, now),
      ),
  };
}

// Refreshes for one shared credential store serialize on a lock file so two
// headless runs (or two sessions in one process) cannot hold overlapping
// refresh grants and revoke each other under token rotation. Fresh tokens
// resolve before the lock: a stalled refresh must never block healthy
// readers behind it.
async function withSerializedCodexRefresh(
  home: string | undefined,
  name: string,
  now: number,
  refresh: () => Promise<CodexAccess>,
): Promise<CodexAccess> {
  const profile = await loadCodexProfile(name, home);
  if (profile === undefined) throw new OAuthProfileNotFoundError(name);
  if (!isCodexTokenExpired(profile.tokens, now))
    return {
      access: profile.tokens.access,
      accountId: profile.tokens.accountId,
    };
  try {
    return await withCodexRefreshLock(
      `${codexAuthPath(home)}.refresh.lock`,
      refresh,
    );
  } catch (err) {
    // A refresh blocked on the lock is a contention/crash-hygiene problem,
    // not a dead credential: surface it as its own error so classifiers and
    // the exec layer keep the lock-path recovery instead of a re-login hint.
    if (err instanceof CodexRefreshLockTimeoutError) {
      throw new CodexRefreshLockError(name, err.lockPath, err.message);
    }
    throw err;
  }
}

// Projects a Codex auth failure onto the shared inference credential_failure
// shape so classifiers compose over one category: a CodexAuthError always
// carries a re-login hint, and anything else is not ours to classify.
export function codexAuthFailureDiagnostic(
  err: unknown,
): InferenceErrorLike | null {
  // Lock contention is never a credential failure (see CodexRefreshLockError):
  // exclude it explicitly so it cannot compose into credential_failure even
  // if a future refactor subtypes it under CodexAuthError.
  if (err instanceof CodexRefreshLockError) return null;
  if (err instanceof CodexAuthError)
    return { category: "credential_failure", message: err.message };
  return null;
}

function sessionFor(home?: string): TokenSession<CodexTokens, CodexAccess> {
  const key = home ?? "";
  const existing = sessions.get(key);
  if (existing !== undefined) return existing;
  const created = createCodexTokenSession(home);
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
