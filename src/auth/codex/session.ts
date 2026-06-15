import { CODEX_REFRESH_SKEW_MS } from "./constants.js";
import { refreshTokens } from "./oauth.js";
import { loadCodexProfile, updateCodexTokens, type CodexTokens } from "./store.js";

// Raised when a Codex profile cannot yield a usable access token: it is gone,
// or its refresh token has been revoked/expired. Carries the profile name so
// the TUI can name the affected profile in a re-login prompt. `reason`
// distinguishes "never authorized" from "refresh rejected" for messaging.
export class CodexAuthError extends Error {
  readonly profile: string;
  readonly reason: "missing" | "refresh-failed";

  constructor(profile: string, reason: "missing" | "refresh-failed", message: string) {
    super(message);
    this.name = "CodexAuthError";
    this.profile = profile;
    this.reason = reason;
  }
}

export function isCodexTokenExpired(tokens: CodexTokens, now: number): boolean {
  return now >= tokens.expiresAt - CODEX_REFRESH_SKEW_MS;
}

// A usable access token plus the account id that must ride alongside it in the
// chatgpt-account-id header. Returned together so callers need a single load,
// not a token fetch followed by a separate profile read (which could observe a
// token and account id from two different points in a concurrent refresh).
export type CodexAccess = { access: string; accountId?: string | undefined };

// Per-profile mutex for token refreshes. When two callers both find the stored
// token expired and both attempt to refresh, the second observes the same
// in-flight promise instead of racing against the auth server's rotation
// policy (which would invalidate one of the refresh attempts and trigger a
// spurious CodexAuthError).
const inflightRefresh = new Map<string, Promise<CodexAccess>>();

// Resolve a valid access token for a Codex profile, refreshing transparently
// when the stored token is at or near expiry. Multiple concurrent calls for
// the same profile coalesce into a single refresh; the second returns the
// result of the first. Throws CodexAuthError when the profile is unknown or
// the refresh is rejected, so callers can prompt for re-login rather than
// sending a dead credential.
export async function getValidCodexToken(
  name: string,
  now: number = Date.now(),
  home?: string,
): Promise<CodexAccess> {
  // Fast path: check expiry without I/O when we already hold a fresh token.
  const existingProfile = await loadCodexProfile(name, home);
  if (existingProfile === undefined) {
    throw new CodexAuthError(name, "missing", `Codex profile "${name}" is not authorized. Log in again.`);
  }
  if (!isCodexTokenExpired(existingProfile.tokens, now)) {
    return { access: existingProfile.tokens.access, accountId: existingProfile.tokens.accountId };
  }

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

async function doRefresh(
  name: string,
  now: number,
  home?: string,
): Promise<CodexAccess> {
  const profile = await loadCodexProfile(name, home);
  if (profile === undefined) {
    throw new CodexAuthError(name, "missing", `Codex profile "${name}" is not authorized. Log in again.`);
  }
  // Re-check expiry after the I/O; another caller may have refreshed already.
  if (!isCodexTokenExpired(profile.tokens, now)) {
    return { access: profile.tokens.access, accountId: profile.tokens.accountId };
  }
  let refreshed: CodexTokens;
  try {
    refreshed = await refreshTokens(profile.tokens.refresh, now);
  } catch (err) {
    throw new CodexAuthError(
      name,
      "refresh-failed",
      `Codex profile "${name}" could not be refreshed (${err instanceof Error ? err.message : String(err)}). Log in again.`,
    );
  }
  // The refresh response rarely re-issues an id_token, so carry the account id
  // forward from the prior tokens when the refresh did not supply one.
  const merged: CodexTokens =
    refreshed.accountId === undefined && profile.tokens.accountId !== undefined
      ? { ...refreshed, accountId: profile.tokens.accountId }
      : refreshed;
  await updateCodexTokens(name, merged, home);
  return { access: merged.access, accountId: merged.accountId };
}
