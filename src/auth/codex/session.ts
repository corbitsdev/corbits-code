import { OAuthProfileNotFoundError } from "@corbits/oauth-core";
import {
  CODEX_REFRESH_SKEW_MS,
  refreshCodexTokens,
  type CodexTokens,
} from "@corbits/codex-provider";
import type { TokenSession } from "@corbits/oauth-core";

import type { InferenceErrorLike } from "../../inference-gateway-error.js";
import {
  loadCodexProfile,
  codexAuthPath,
  updateCodexTokens,
} from "../../config/oauth-stores.js";
import {
  withCodexRefreshLock,
  CodexRefreshLockTimeoutError,
} from "./refresh-lock.js";
import { withDefaultCodexExpiry } from "./store.js";
import {
  createProviderTokenSession,
  type TokenSessionCallContext,
} from "../provider-token-session.js";

// Raised when a Codex profile cannot yield a usable access token: it is gone,
// or its refresh token was revoked/expired. Carries the profile name and a
// `reason` ("missing" vs "refresh-failed") for re-login messaging.
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

// Raised when a Codex refresh cannot acquire the inter-process refresh lock:
// contention or a crashed holder's leftover file, never a bad credential.
// Deliberately NOT a CodexAuthError — folding it into credential_failure
// sends the operator into a re-login loop that never removes the lock file.
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

// A usable access token plus the account id that rides alongside it in the
// chatgpt-account-id header. Returned together so callers need a single load,
// not a token fetch plus a profile read that could straddle a concurrent refresh.
export interface CodexAccess {
  access: string;
  accountId?: string | undefined;
}

export const codexTokensSession = createProviderTokenSession<
  CodexTokens,
  CodexAccess
>({
  errorClass: CodexAuthError,
  providerLabel: "Codex",
  skewMs: CODEX_REFRESH_SKEW_MS,
  loadProfile: loadCodexProfile,
  updateTokens: updateCodexTokens,
  toAccess: (tokens) => ({
    access: tokens.access,
    accountId: tokens.accountId,
  }),
  refreshTokens: async (refreshToken, now, previous) =>
    // The session-driven refresh has no prior tokens to lean on; the mapper
    // only needs the refresh grant itself. Staged refreshes pass the real
    // prior tokens through.
    withDefaultCodexExpiry(
      await refreshCodexTokens(
        refreshToken,
        now,
        previous ?? { access: "", refresh: refreshToken },
      ),
      now,
    ),
  // Keep the stored chatgpt account id when the refresh response omits
  // id_token; the shared factory carries the refresh basis for the store CAS.
  mergeRefreshed: (refreshed, previous) =>
    refreshed.accountId === undefined && previous.accountId !== undefined
      ? { ...refreshed, accountId: previous.accountId }
      : refreshed,
  serializeRefresh: (ctx) => serializeCodexRefresh(ctx),
});

// Refreshes for one shared credential store serialize on a lock file so two
// headless runs (or two sessions in one process) cannot hold overlapping
// refresh grants and revoke each other under token rotation. Fresh tokens
// resolve before the lock: a stalled refresh never blocks healthy readers.
async function serializeCodexRefresh({
  home,
  name,
  now,
  getValid,
}: TokenSessionCallContext<CodexTokens, CodexAccess>): Promise<CodexAccess> {
  const profile = await loadCodexProfile(name, home);
  if (profile === undefined) throw new OAuthProfileNotFoundError(name);
  if (!codexTokensSession.isExpired(profile.tokens, now))
    return {
      access: profile.tokens.access,
      accountId: profile.tokens.accountId,
    };
  try {
    return await withCodexRefreshLock(
      `${codexAuthPath(home)}.refresh.lock`,
      getValid,
    );
  } catch (err) {
    // A lock-blocked refresh is contention/crash hygiene, not a dead
    // credential: surface it as its own error so classifiers and exec keep
    // the lock-path recovery instead of a re-login hint.
    if (err instanceof CodexRefreshLockTimeoutError) {
      throw new CodexRefreshLockError(name, err.lockPath, err.message);
    }
    throw err;
  }
}

// Projects a Codex auth failure onto the shared credential_failure shape:
// a CodexAuthError always carries a re-login hint, and anything else is not
// ours to classify.
export function codexAuthFailureDiagnostic(
  err: unknown,
): InferenceErrorLike | null {
  // Lock contention is never a credential failure (see CodexRefreshLockError):
  // exclude it so it cannot compose into credential_failure even if a future
  // refactor subtypes it under CodexAuthError.
  if (err instanceof CodexRefreshLockError) return null;
  if (err instanceof CodexAuthError)
    return { category: "credential_failure", message: err.message };
  return null;
}

/**
 * Independent Codex token session for a home directory. Each session carries
 * its own in-flight deduplication and serializes inter-process refreshes on
 * the credential file lock.
 */
export function createCodexTokenSession(
  home?: string,
): TokenSession<CodexTokens, CodexAccess> {
  return codexTokensSession.createSession(home);
}

export function isCodexTokenExpired(tokens: CodexTokens, now: number): boolean {
  return codexTokensSession.isExpired(tokens, now);
}

export async function getValidCodexToken(
  name: string,
  now?: number,
  home?: string,
): Promise<CodexAccess> {
  return codexTokensSession.getValidToken(name, now, home);
}

export async function refreshStagedCodexTokens(
  tokens: CodexTokens,
  now: number = Date.now(),
): Promise<CodexTokens> {
  return codexTokensSession.refreshStaged(tokens, now);
}
